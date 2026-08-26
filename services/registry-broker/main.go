package main

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxBodyBytes    = 64 << 10
	maxSecretBytes  = 16 << 10
	brokerUser      = "raibit-build"
	credentialV1    = "rb1"
	defaultPort     = "8080"
	defaultTokenTTL = 5 * time.Minute
	defaultTLSMin   = uint16(tls.VersionTLS12)
)

type config struct {
	Port                string
	RegistryHost        string
	RegistryPrefix      string
	RegistryService     string
	RegistryIssuer      string
	BrokerToken         string
	SessionHMACKey      []byte
	TokenPrivateKey     *rsa.PrivateKey
	TokenCertificateX5C string
	InternalTLS         tlsGatewayConfig
}

type tlsGatewayConfig struct {
	Enabled          bool
	Port             string
	BrokerHost       string
	CertificateFile  string
	PrivateKeyFile   string
	RegistryUpstream *url.URL
}

type certificateFileState struct {
	certificate os.FileInfo
	privateKey  os.FileInfo
}

type certificateReloader struct {
	mu              sync.Mutex
	certificateFile string
	privateKeyFile  string
	certificate     tls.Certificate
	state           certificateFileState
}

type server struct {
	cfg config
	now func() time.Time
}

type brokerRequest struct {
	OrganizationID string   `json:"organizationId"`
	ProjectID      string   `json:"projectId"`
	ServiceID      string   `json:"serviceId"`
	JobID          string   `json:"jobId"`
	Repository     string   `json:"repository"`
	Actions        []string `json:"actions"`
	MinTTLSeconds  int64    `json:"minTtlSeconds"`
	MaxTTLSeconds  int64    `json:"maxTtlSeconds"`
}

type brokerResponse struct {
	Repository string `json:"repository"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	ExpiresAt  string `json:"expiresAt"`
}

type credentialClaims struct {
	Version    int      `json:"v"`
	Repository string   `json:"repo"`
	Actions    []string `json:"actions"`
	JobID      string   `json:"job"`
	IssuedAt   int64    `json:"iat"`
	ExpiresAt  int64    `json:"exp"`
}

type registryAccess struct {
	Type    string   `json:"type"`
	Name    string   `json:"name"`
	Actions []string `json:"actions"`
}

type registryJWTClaims struct {
	Issuer    string           `json:"iss"`
	Subject   string           `json:"sub"`
	Audience  string           `json:"aud"`
	Expires   int64            `json:"exp"`
	NotBefore int64            `json:"nbf"`
	IssuedAt  int64            `json:"iat"`
	JWTID     string           `json:"jti"`
	Access    []registryAccess `json:"access"`
}

type tokenResponse struct {
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	ExpiresIn   int64  `json:"expires_in"`
	IssuedAt    string `json:"issued_at"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("configuration: %v", err)
	}

	s := &server{cfg: cfg, now: func() time.Time { return time.Now().UTC() }}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /broker", s.broker)
	mux.HandleFunc("GET /token", s.token)

	publicServer := hardenedHTTPServer(":"+cfg.Port, securityHeaders(mux))
	var internalServer *http.Server
	if cfg.InternalTLS.Enabled {
		internalServer, err = newInternalTLSServer(cfg, mux)
		if err != nil {
			log.Fatalf("internal TLS gateway: %v", err)
		}
	}

	errCh := make(chan error, 2)
	go func() {
		log.Printf("registry broker listening on %s for %s/%s", publicServer.Addr, cfg.RegistryHost, cfg.RegistryPrefix)
		errCh <- publicServer.ListenAndServe()
	}()

	if internalServer != nil {
		go func() {
			log.Printf("internal registry TLS gateway listening on %s", internalServer.Addr)
			errCh <- internalServer.ListenAndServeTLS("", "")
		}()
	}

	log.Fatal(<-errCh)
}

func loadConfig() (config, error) {
	cfg := config{
		Port:            firstNonEmpty(os.Getenv("PORT"), defaultPort),
		RegistryHost:    strings.ToLower(strings.TrimSpace(os.Getenv("REGISTRY_HOST"))),
		RegistryPrefix:  strings.ToLower(strings.Trim(strings.TrimSpace(os.Getenv("REGISTRY_PREFIX")), "/")),
		RegistryService: strings.TrimSpace(os.Getenv("REGISTRY_SERVICE")),
		RegistryIssuer:  strings.TrimSpace(os.Getenv("REGISTRY_ISSUER")),
	}
	if !validBareHostname(cfg.RegistryHost) {
		return config{}, errors.New("REGISTRY_HOST must be a bare registry hostname")
	}
	if cfg.RegistryPrefix == "" || strings.ContainsAny(cfg.RegistryPrefix, ":@ ") {
		return config{}, errors.New("REGISTRY_PREFIX is required")
	}
	if cfg.RegistryService == "" || cfg.RegistryIssuer == "" {
		return config{}, errors.New("REGISTRY_SERVICE and REGISTRY_ISSUER are required")
	}

	var err error
	cfg.InternalTLS, err = loadTLSGatewayConfig(os.Getenv, cfg.RegistryHost)
	if err != nil {
		return config{}, err
	}

	cfg.BrokerToken, err = readSecretFile(os.Getenv("BROKER_TOKEN_FILE"))
	if err != nil {
		return config{}, fmt.Errorf("broker token: %w", err)
	}
	hmacSecret, err := readSecretFile(os.Getenv("SESSION_HMAC_KEY_FILE"))
	if err != nil {
		return config{}, fmt.Errorf("session HMAC key: %w", err)
	}
	if len(hmacSecret) < 32 {
		return config{}, errors.New("session HMAC key must be at least 32 bytes")
	}
	cfg.SessionHMACKey = []byte(hmacSecret)

	cfg.TokenPrivateKey, err = loadRSAPrivateKey(os.Getenv("TOKEN_PRIVATE_KEY_FILE"))
	if err != nil {
		return config{}, fmt.Errorf("token private key: %w", err)
	}
	cfg.TokenCertificateX5C, err = loadCertificateX5C(os.Getenv("TOKEN_CERT_FILE"))
	if err != nil {
		return config{}, fmt.Errorf("token certificate: %w", err)
	}
	return cfg, nil
}

func loadTLSGatewayConfig(getenv func(string) string, registryHost string) (tlsGatewayConfig, error) {
	raw := map[string]string{
		"BROKER_HOST":            strings.TrimSpace(getenv("BROKER_HOST")),
		"INTERNAL_TLS_PORT":      strings.TrimSpace(getenv("INTERNAL_TLS_PORT")),
		"INTERNAL_TLS_CERT_FILE": strings.TrimSpace(getenv("INTERNAL_TLS_CERT_FILE")),
		"INTERNAL_TLS_KEY_FILE":  strings.TrimSpace(getenv("INTERNAL_TLS_KEY_FILE")),
		"REGISTRY_UPSTREAM_URL":  strings.TrimSpace(getenv("REGISTRY_UPSTREAM_URL")),
	}
	enabled := false
	for _, value := range raw {
		enabled = enabled || value != ""
	}
	if !enabled {
		return tlsGatewayConfig{}, nil
	}
	for name, value := range raw {
		if value == "" {
			return tlsGatewayConfig{}, fmt.Errorf("%s is required when the internal TLS gateway is enabled", name)
		}
	}

	brokerHost := strings.ToLower(raw["BROKER_HOST"])
	if !validBareHostname(brokerHost) {
		return tlsGatewayConfig{}, errors.New("BROKER_HOST must be a bare hostname")
	}
	if brokerHost == registryHost {
		return tlsGatewayConfig{}, errors.New("BROKER_HOST and REGISTRY_HOST must be different")
	}
	port, err := strconv.Atoi(raw["INTERNAL_TLS_PORT"])
	if err != nil || port < 1 || port > 65535 {
		return tlsGatewayConfig{}, errors.New("INTERNAL_TLS_PORT must be an integer between 1 and 65535")
	}
	upstream, err := url.Parse(raw["REGISTRY_UPSTREAM_URL"])
	if err != nil || upstream.Scheme != "http" || upstream.Host == "" || upstream.User != nil || upstream.RawQuery != "" || upstream.Fragment != "" || (upstream.Path != "" && upstream.Path != "/") {
		return tlsGatewayConfig{}, errors.New("REGISTRY_UPSTREAM_URL must be a fixed HTTP origin without credentials, path, query, or fragment")
	}
	if upstream.Hostname() == "" || strings.ContainsAny(upstream.Hostname(), "/@ ") {
		return tlsGatewayConfig{}, errors.New("REGISTRY_UPSTREAM_URL contains an invalid host")
	}
	upstreamHost := strings.ToLower(upstream.Hostname())
	if upstreamHost != "raibit-registry" {
		return tlsGatewayConfig{}, errors.New("REGISTRY_UPSTREAM_URL must target the exact raibit-registry service")
	}
	if upstream.Port() != "5000" {
		return tlsGatewayConfig{}, errors.New("REGISTRY_UPSTREAM_URL must target registry port 5000")
	}

	return tlsGatewayConfig{
		Enabled:          true,
		Port:             strconv.Itoa(port),
		BrokerHost:       brokerHost,
		CertificateFile:  raw["INTERNAL_TLS_CERT_FILE"],
		PrivateKeyFile:   raw["INTERNAL_TLS_KEY_FILE"],
		RegistryUpstream: upstream,
	}, nil
}

func validBareHostname(host string) bool {
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/:@ ") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
				return false
			}
		}
	}
	return true
}

func hardenedHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func hardenedRegistryGatewayServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Minute,
		WriteTimeout:      30 * time.Minute,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func newCertificateReloader(certificateFile, privateKeyFile string) (*certificateReloader, error) {
	certificate, state, err := loadStableCertificatePair(certificateFile, privateKeyFile)
	if err != nil {
		return nil, err
	}
	return &certificateReloader{
		certificateFile: certificateFile,
		privateKeyFile:  privateKeyFile,
		certificate:     certificate,
		state:           state,
	}, nil
}

func (r *certificateReloader) current() (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	state, err := statCertificatePair(r.certificateFile, r.privateKeyFile)
	if err != nil {
		return nil, err
	}
	if certificateFileStatesEqual(r.state, state) {
		certificate := r.certificate
		return &certificate, nil
	}

	certificate, state, err := loadStableCertificatePair(r.certificateFile, r.privateKeyFile)
	if err != nil {
		return nil, err
	}
	r.certificate = certificate
	r.state = state
	copy := r.certificate
	return &copy, nil
}

func loadStableCertificatePair(certificateFile, privateKeyFile string) (tls.Certificate, certificateFileState, error) {
	for attempt := 0; attempt < 3; attempt++ {
		before, err := statCertificatePair(certificateFile, privateKeyFile)
		if err != nil {
			return tls.Certificate{}, certificateFileState{}, err
		}
		certificate, err := tls.LoadX509KeyPair(certificateFile, privateKeyFile)
		if err != nil {
			return tls.Certificate{}, certificateFileState{}, errors.New("certificate or private key could not be loaded")
		}
		after, err := statCertificatePair(certificateFile, privateKeyFile)
		if err != nil {
			return tls.Certificate{}, certificateFileState{}, err
		}
		if certificateFileStatesEqual(before, after) {
			return certificate, after, nil
		}
	}
	return tls.Certificate{}, certificateFileState{}, errors.New("certificate or private key changed during reload")
}

func statCertificatePair(certificateFile, privateKeyFile string) (certificateFileState, error) {
	certificateInfo, err := os.Stat(certificateFile)
	if err != nil || !certificateInfo.Mode().IsRegular() {
		return certificateFileState{}, errors.New("certificate file is unavailable")
	}
	privateKeyInfo, err := os.Stat(privateKeyFile)
	if err != nil || !privateKeyInfo.Mode().IsRegular() {
		return certificateFileState{}, errors.New("private key file is unavailable")
	}
	return certificateFileState{certificate: certificateInfo, privateKey: privateKeyInfo}, nil
}

func certificateFileStatesEqual(left, right certificateFileState) bool {
	return fileInfoEqual(left.certificate, right.certificate) && fileInfoEqual(left.privateKey, right.privateKey)
}

func fileInfoEqual(left, right os.FileInfo) bool {
	return left != nil && right != nil && os.SameFile(left, right) && left.Size() == right.Size() && left.ModTime().Equal(right.ModTime())
}

func newInternalTLSServer(cfg config, brokerHandler http.Handler) (*http.Server, error) {
	certificateReloader, err := newCertificateReloader(cfg.InternalTLS.CertificateFile, cfg.InternalTLS.PrivateKeyFile)
	if err != nil {
		return nil, errors.New("certificate or private key could not be loaded")
	}
	server := hardenedRegistryGatewayServer(":"+cfg.InternalTLS.Port, securityHeaders(newTLSGatewayHandler(cfg, brokerHandler)))
	server.TLSConfig = &tls.Config{
		MinVersion: defaultTLSMin,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			if !allowedTLSHost(strings.ToLower(strings.TrimSuffix(hello.ServerName, ".")), cfg) {
				return nil, errors.New("unrecognized TLS server name")
			}
			return certificateReloader.current()
		},
	}
	return server, nil
}

func newTLSGatewayHandler(cfg config, brokerHandler http.Handler) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(cfg.InternalTLS.RegistryUpstream)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Host = cfg.InternalTLS.RegistryUpstream.Host
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("X-Forwarded-Host")
		r.Header.Del("X-Forwarded-Proto")
	}
	proxy.Transport = &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		log.Print("internal registry upstream request failed")
		http.Error(w, "registry upstream unavailable", http.StatusBadGateway)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, ok := requestHostname(r.Host)
		if !ok || r.TLS == nil {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		sni := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(r.TLS.ServerName), "."))
		if sni == "" || host != sni || !allowedTLSHost(host, cfg) {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		switch host {
		case cfg.InternalTLS.BrokerHost:
			brokerHandler.ServeHTTP(w, r)
		case cfg.RegistryHost:
			proxy.ServeHTTP(w, r)
		default:
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		}
	})
}

func requestHostname(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	host := value
	if strings.Contains(value, ":") {
		var err error
		var port string
		host, port, err = net.SplitHostPort(value)
		if err != nil {
			return "", false
		}
		parsedPort, err := strconv.Atoi(port)
		if err != nil || parsedPort < 1 || parsedPort > 65535 {
			return "", false
		}
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host, validBareHostname(host)
}

func allowedTLSHost(host string, cfg config) bool {
	return host == cfg.InternalTLS.BrokerHost || host == cfg.RegistryHost
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`)
}

func (s *server) broker(w http.ResponseWriter, r *http.Request) {
	if !bearerMatches(r.Header.Get("Authorization"), s.cfg.BrokerToken) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if ct := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])); ct != "application/json" {
		http.Error(w, "content-type must be application/json", http.StatusUnsupportedMediaType)
		return
	}

	var req brokerRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes+1))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if err := ensureJSONEOF(dec); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if err := validateBrokerRequest(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	expected := s.expectedRepository(req.OrganizationID, req.ProjectID, req.ServiceID)
	if !strings.EqualFold(strings.TrimSpace(req.Repository), expected) {
		http.Error(w, "repository does not match authoritative build identity", http.StatusForbidden)
		return
	}

	requestedActions, err := normalizeActions(req.Actions)
	if err != nil || !containsAction(requestedActions, "pull") || !containsAction(requestedActions, "push") {
		http.Error(w, "broker request must be limited to pull,push", http.StatusBadRequest)
		return
	}

	now := s.now()
	ttl := req.MinTTLSeconds + (req.MaxTTLSeconds-req.MinTTLSeconds)/2
	if ttl < req.MinTTLSeconds {
		ttl = req.MinTTLSeconds
	}
	if ttl > req.MaxTTLSeconds {
		ttl = req.MaxTTLSeconds
	}
	expires := now.Add(time.Duration(ttl) * time.Second)

	claims := credentialClaims{
		Version:    1,
		Repository: strings.TrimPrefix(expected, s.cfg.RegistryHost+"/"),
		Actions:    requestedActions,
		JobID:      strings.TrimSpace(req.JobID),
		IssuedAt:   now.Unix(),
		ExpiresAt:  expires.Unix(),
	}
	password, err := s.signCredential(claims)
	if err != nil {
		http.Error(w, "credential issuance failed", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, brokerResponse{
		Repository: expected,
		Username:   brokerUser,
		Password:   password,
		ExpiresAt:  expires.Format(time.RFC3339Nano),
	})
}

func (s *server) token(w http.ResponseWriter, r *http.Request) {
	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service != "" && service != s.cfg.RegistryService {
		http.Error(w, "invalid service", http.StatusBadRequest)
		return
	}

	var credential *credentialClaims
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		user, password, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(user), []byte(brokerUser)) != 1 {
			basicUnauthorized(w)
			return
		}
		claims, err := s.verifyCredential(password)
		if err != nil {
			basicUnauthorized(w)
			return
		}
		credential = &claims
	}

	access := make([]registryAccess, 0, len(r.URL.Query()["scope"]))
	for _, raw := range r.URL.Query()["scope"] {
		resourceType, name, actions, ok := parseScope(raw)
		if !ok || resourceType != "repository" {
			continue
		}
		granted := make([]string, 0, len(actions))
		for _, action := range actions {
			switch action {
			case "pull":
				granted = append(granted, "pull")
			case "push":
				if credential != nil && name == credential.Repository && containsAction(credential.Actions, "push") {
					granted = append(granted, "push")
				}
			}
		}
		granted = uniqueSorted(granted)
		if len(granted) > 0 {
			access = append(access, registryAccess{Type: "repository", Name: name, Actions: granted})
		}
	}

	now := s.now()
	tokenTTL := defaultTokenTTL
	if credential != nil {
		remaining := time.Unix(credential.ExpiresAt, 0).Sub(now)
		if remaining < tokenTTL {
			tokenTTL = remaining
		}
	}
	if tokenTTL < 30*time.Second {
		basicUnauthorized(w)
		return
	}

	subject := ""
	if credential != nil {
		subject = brokerUser
	}
	jwt, err := s.signRegistryJWT(registryJWTClaims{
		Issuer:    s.cfg.RegistryIssuer,
		Subject:   subject,
		Audience:  s.cfg.RegistryService,
		Expires:   now.Add(tokenTTL).Unix(),
		NotBefore: now.Add(-5 * time.Second).Unix(),
		IssuedAt:  now.Unix(),
		JWTID:     randomID(),
		Access:    access,
	})
	if err != nil {
		http.Error(w, "token issuance failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tokenResponse{
		Token:       jwt,
		AccessToken: jwt,
		ExpiresIn:   int64(tokenTTL / time.Second),
		IssuedAt:    now.Format(time.RFC3339Nano),
	})
}

func validateBrokerRequest(req brokerRequest) error {
	for name, value := range map[string]string{
		"organizationId": req.OrganizationID,
		"projectId":      req.ProjectID,
		"serviceId":      req.ServiceID,
		"jobId":          req.JobID,
		"repository":     req.Repository,
	} {
		if strings.TrimSpace(value) == "" || len(value) > 1024 {
			return fmt.Errorf("%s is required and must be bounded", name)
		}
	}
	if req.MinTTLSeconds < 60 || req.MaxTTLSeconds > 900 || req.MinTTLSeconds > req.MaxTTLSeconds {
		return errors.New("TTL window must stay within 60..900 seconds")
	}
	return nil
}

func (s *server) expectedRepository(orgID, projectID, serviceID string) string {
	return strings.Join([]string{
		s.cfg.RegistryHost,
		s.cfg.RegistryPrefix,
		immutableIdentitySegment("org", orgID),
		immutableIdentitySegment("project", projectID),
		immutableIdentitySegment("service", serviceID),
	}, "/")
}

func immutableIdentitySegment(kind, value string) string {
	sum := sha256.Sum256([]byte("raibitserver-registry-segment-v1\x00" + kind + "\x00" + strings.TrimSpace(value)))
	return kind + "-" + hex.EncodeToString(sum[:12])
}

func (s *server) signCredential(claims credentialClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.cfg.SessionHMACKey)
	_, _ = mac.Write([]byte(credentialV1 + "." + encoded))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return credentialV1 + "." + encoded + "." + sig, nil
}

func (s *server) verifyCredential(value string) (credentialClaims, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != credentialV1 {
		return credentialClaims{}, errors.New("invalid credential")
	}
	mac := hmac.New(sha256.New, s.cfg.SessionHMACKey)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := mac.Sum(nil)
	provided, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(expected, provided) {
		return credentialClaims{}, errors.New("invalid credential signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) > maxBodyBytes {
		return credentialClaims{}, errors.New("invalid credential payload")
	}
	var claims credentialClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Version != 1 {
		return credentialClaims{}, errors.New("invalid credential claims")
	}
	if claims.Repository == "" || claims.ExpiresAt <= s.now().Unix() || claims.IssuedAt > s.now().Add(30*time.Second).Unix() {
		return credentialClaims{}, errors.New("expired or invalid credential")
	}
	if _, err := normalizeActions(claims.Actions); err != nil {
		return credentialClaims{}, errors.New("invalid credential actions")
	}
	return claims, nil
}

func (s *server) signRegistryJWT(claims registryJWTClaims) (string, error) {
	headerBytes, err := json.Marshal(map[string]any{
		"alg": "RS256",
		"typ": "JWT",
		"x5c": []string{s.cfg.TokenCertificateX5C},
	})
	if err != nil {
		return "", err
	}
	claimsBytes, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString(headerBytes)
	body := base64.RawURLEncoding.EncodeToString(claimsBytes)
	signingInput := header + "." + body
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, s.cfg.TokenPrivateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func parseScope(raw string) (resourceType, name string, actions []string, ok bool) {
	parts := strings.SplitN(strings.TrimSpace(raw), ":", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		return "", "", nil, false
	}
	parsed := strings.Split(parts[2], ",")
	for _, action := range parsed {
		action = strings.ToLower(strings.TrimSpace(action))
		if action != "" {
			actions = append(actions, action)
		}
	}
	return parts[0], parts[1], uniqueSorted(actions), true
}

func normalizeActions(input []string) ([]string, error) {
	out := make([]string, 0, len(input))
	for _, action := range input {
		action = strings.ToLower(strings.TrimSpace(action))
		if action != "pull" && action != "push" {
			return nil, fmt.Errorf("unsupported registry action %q", action)
		}
		out = append(out, action)
	}
	out = uniqueSorted(out)
	if len(out) == 0 {
		return nil, errors.New("registry actions are required")
	}
	return out, nil
}

func uniqueSorted(values []string) []string {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != "" {
			set[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for value := range set {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func containsAction(actions []string, wanted string) bool {
	for _, action := range actions {
		if action == wanted {
			return true
		}
	}
	return false
}

func bearerMatches(header, secret string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	provided := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	return subtle.ConstantTimeCompare([]byte(provided), []byte(secret)) == 1
}

func basicUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="raibit-registry-auth"`)
	http.Error(w, "invalid registry credential", http.StatusUnauthorized)
}

func readSecretFile(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("secret file path is required")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSecretBytes+1))
	if err != nil {
		return "", err
	}
	if len(b) == 0 || len(b) > maxSecretBytes {
		return "", errors.New("secret is empty or too large")
	}
	value := strings.TrimSpace(string(b))
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", errors.New("secret is malformed")
	}
	return value, nil
}

func loadRSAPrivateKey(path string) (*rsa.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("private key PEM is invalid")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("private key is not RSA")
		}
		return rsaKey, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("unsupported RSA private key encoding")
}

func loadCertificateX5C(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errors.New("certificate PEM is invalid")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(block.Bytes), nil
}

func ensureJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}

func randomID() string {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
