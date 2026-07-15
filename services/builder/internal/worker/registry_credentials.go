package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	registryBrokerTimeout            = 10 * time.Second
	registryBrokerMaxBodyBytes       = 64 << 10
	registryBrokerMaxTokenBytes      = 16 << 10
	defaultBuildCommandTimeout       = 10 * time.Minute
	defaultRegistryCredentialMinTTL  = 14 * time.Minute
	defaultRegistryCredentialMaxTTL  = 15 * time.Minute
	registryCredentialMinimumTTL     = time.Minute
	registryCredentialExpiryHeadroom = time.Minute
)

type registryCredentialRequest struct {
	OrganizationID string   `json:"organizationId"`
	ProjectID      string   `json:"projectId"`
	ServiceID      string   `json:"serviceId"`
	JobID          string   `json:"jobId"`
	Repository     string   `json:"repository"`
	Actions        []string `json:"actions"`
	MinTTLSeconds  int64    `json:"minTtlSeconds"`
	MaxTTLSeconds  int64    `json:"maxTtlSeconds"`
}

type registryCredentialResponse struct {
	Repository string `json:"repository"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	ExpiresAt  string `json:"expiresAt"`
}

func (b *Builder) issuePerBuildRegistryCredential(ctx context.Context, state *buildContext) (map[string]string, error) {
	if err := validateRegistryCredentialBrokerURL(b.Config.RegistryCredentialBrokerURL); err != nil {
		return nil, err
	}
	if strings.TrimSpace(b.Config.RegistryCredentialBrokerTokenFile) == "" {
		return nil, errors.New("live source build requires a secret-backed registry credential broker token file")
	}
	repository, err := b.derivedImageRepository(state)
	if err != nil {
		return nil, err
	}
	if err := validateExactImageRepository(state.Image, repository); err != nil {
		return nil, err
	}
	token, err := readBoundedSecretFile(b.Config.RegistryCredentialBrokerTokenFile, registryBrokerMaxTokenBytes)
	if err != nil {
		return nil, fmt.Errorf("read registry credential broker token: %w", err)
	}
	minTTL := b.Config.RegistryCredentialMinTTL
	maxTTL := b.Config.RegistryCredentialMaxTTL
	if minTTL <= 0 {
		minTTL = defaultRegistryCredentialMinTTL
	}
	if maxTTL <= 0 {
		maxTTL = defaultRegistryCredentialMaxTTL
	}
	payload, err := json.Marshal(registryCredentialRequest{
		OrganizationID: state.Project.OrganizationID,
		ProjectID:      state.Project.ID,
		ServiceID:      state.Service.ID,
		JobID:          state.Job.ID,
		Repository:     repository,
		Actions:        []string{"pull", "push"},
		MinTTLSeconds:  int64(minTTL / time.Second),
		MaxTTLSeconds:  int64(maxTTL / time.Second),
	})
	if err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, registryBrokerTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, b.Config.RegistryCredentialBrokerURL, bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("create registry credential broker request")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	client := http.DefaultClient
	if b.Config.RegistryCredentialBrokerHTTPClient != nil {
		client = b.Config.RegistryCredentialBrokerHTTPClient
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("registry credential broker redirects are not allowed")
	}
	response, err := clientCopy.Do(request)
	if err != nil {
		return nil, errors.New("registry credential broker request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, registryBrokerMaxBodyBytes))
		return nil, fmt.Errorf("registry credential broker returned status %d", response.StatusCode)
	}
	var issued registryCredentialResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, registryBrokerMaxBodyBytes+1))
	if err := decoder.Decode(&issued); err != nil {
		return nil, errors.New("registry credential broker returned invalid JSON")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	if strings.ToLower(strings.TrimSpace(issued.Repository)) != repository {
		return nil, errors.New("registry credential broker credential does not match the exact output repository")
	}
	if issued.Username == "" || len(issued.Username) > 256 || issued.Password == "" || len(issued.Password) > 4096 {
		return nil, errors.New("registry credential broker returned an invalid credential")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, issued.ExpiresAt)
	if err != nil {
		return nil, errors.New("registry credential broker returned an invalid expiry")
	}
	now := time.Now().UTC()
	if expiresAt.Before(now.Add(minTTL)) || expiresAt.After(now.Add(maxTTL)) {
		return nil, errors.New("registry credential broker credential lifetime is outside the allowed short-lived window")
	}
	registryPrefix, _, err := normalizedRegistryPrefix(b.Config.Registry)
	if err != nil {
		return nil, err
	}
	registryHost := strings.SplitN(registryPrefix, "/", 2)[0]
	auth := base64.StdEncoding.EncodeToString([]byte(issued.Username + ":" + issued.Password))
	dockerConfig, err := json.Marshal(map[string]any{
		"auths": map[string]any{registryHost: map[string]string{"auth": auth}},
	})
	if err != nil {
		return nil, err
	}
	credentialDir := filepath.Join(state.MetadataDir, "registry-auth")
	if err := os.Mkdir(credentialDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(credentialDir, "config.json"), dockerConfig, 0o600); err != nil {
		return nil, err
	}
	return map[string]string{"DOCKER_CONFIG": credentialDir}, nil
}

func validateRegistryCredentialLifetimeConfig(config Config) error {
	if config.RegistryCredentialMinTTL < registryCredentialMinimumTTL || config.RegistryCredentialMaxTTL > defaultRegistryCredentialMaxTTL || config.RegistryCredentialMinTTL > config.RegistryCredentialMaxTTL {
		return errors.New("production registry credential lifetime must remain between 60 and 900 seconds with minimum TTL not exceeding maximum TTL")
	}
	if config.Timeout <= 0 || config.Timeout+registryCredentialExpiryHeadroom > config.RegistryCredentialMinTTL {
		return errors.New("production registry credential minimum TTL must outlive the build command timeout by at least 60 seconds")
	}
	return nil
}

func validateRegistryCredentialBrokerURL(value string) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("live registry credential broker URL must be an explicit https URL without credentials or fragments")
	}
	return nil
}

func readBoundedSecretFile(path string, maxBytes int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(content)) > maxBytes {
		return "", errors.New("secret file exceeds the allowed size")
	}
	value := strings.TrimSpace(string(content))
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", errors.New("secret file is empty or malformed")
	}
	return value, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("registry credential broker returned trailing data")
	}
	return nil
}
