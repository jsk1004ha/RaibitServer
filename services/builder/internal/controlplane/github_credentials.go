package controlplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultGitHubAPIURL = "https://api.github.com"

type GitHubRepositoryCredential struct {
	Token             string    `json:"token"`
	InstallationID    string    `json:"installationId"`
	RepositoryID      string    `json:"repositoryId"`
	UpstreamExpiresAt time.Time `json:"upstreamExpiresAt"`
	UseDeadline       time.Time `json:"useDeadline"`
}

type GitHubCredentialIssuer interface {
	IssueRepositoryCredential(context.Context, string, string) (*GitHubRepositoryCredential, error)
	RevokeRepositoryCredential(context.Context, string) error
}

type GitHubPullRequestCredentialIssuer interface {
	IssuePullRequestCredential(context.Context, string, string) (*GitHubRepositoryCredential, error)
	RevokeRepositoryCredential(context.Context, string) error
}

type GitHubAppCredentialIssuerConfig struct {
	AppID          string
	PrivateKeyFile string
	APIURL         string
	HTTPClient     *http.Client
	Now            func() time.Time
}

type gitHubAppCredentialIssuer struct {
	appID      string
	privateKey *rsa.PrivateKey
	apiURL     string
	client     *http.Client
	now        func() time.Time
}

func NewGitHubAppCredentialIssuer(config GitHubAppCredentialIssuerConfig) (GitHubCredentialIssuer, error) {
	appID := strings.TrimSpace(config.AppID)
	privateKeyFile := strings.TrimSpace(config.PrivateKeyFile)
	if appID == "" && privateKeyFile == "" {
		return nil, nil
	}
	if appID == "" || privateKeyFile == "" {
		return nil, errors.New("GitHub App credential broker requires both app ID and private key file")
	}
	if _, err := strconv.ParseInt(appID, 10, 64); err != nil {
		return nil, errors.New("GitHub App ID must be numeric")
	}
	privateKeyPEM, err := os.ReadFile(privateKeyFile)
	if err != nil {
		return nil, fmt.Errorf("read GitHub App private key: %w", err)
	}
	privateKey, err := parseGitHubAppPrivateKey(privateKeyPEM)
	if err != nil {
		return nil, err
	}
	apiURL := strings.TrimRight(strings.TrimSpace(config.APIURL), "/")
	if apiURL == "" {
		apiURL = defaultGitHubAPIURL
	}
	parsedAPIURL, err := url.Parse(apiURL)
	if err != nil || parsedAPIURL.Scheme != "https" || parsedAPIURL.Host == "" || parsedAPIURL.User != nil || parsedAPIURL.RawQuery != "" || parsedAPIURL.Fragment != "" {
		return nil, errors.New("GitHub API URL must be an https URL without credentials, query parameters, or fragments")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	clientCopy := *client
	clientCopy.Timeout = 15 * time.Second
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &gitHubAppCredentialIssuer{appID: appID, privateKey: privateKey, apiURL: apiURL, client: &clientCopy, now: now}, nil
}

func (i *gitHubAppCredentialIssuer) IssueRepositoryCredential(ctx context.Context, installationID, repositoryID string) (*GitHubRepositoryCredential, error) {
	return i.issueRepositoryCredential(ctx, installationID, repositoryID, "contents", false)
}

func (i *gitHubAppCredentialIssuer) IssuePullRequestCredential(ctx context.Context, installationID, repositoryID string) (*GitHubRepositoryCredential, error) {
	return i.issueRepositoryCredential(ctx, installationID, repositoryID, "pull_requests", true)
}

func (i *gitHubAppCredentialIssuer) issueRepositoryCredential(ctx context.Context, installationID, repositoryID, permission string, verifyPermission bool) (*GitHubRepositoryCredential, error) {
	installationID = strings.TrimSpace(installationID)
	repositoryID = strings.TrimSpace(repositoryID)
	numericInstallationID, err := strconv.ParseInt(installationID, 10, 64)
	if err != nil || numericInstallationID <= 0 {
		return nil, errors.New("GitHub installation ID must be numeric")
	}
	numericRepositoryID, err := strconv.ParseInt(repositoryID, 10, 64)
	if err != nil || numericRepositoryID <= 0 {
		return nil, errors.New("GitHub repository ID must be a positive numeric identifier")
	}
	now := i.now().UTC()
	jwt, err := i.signJWT(now)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(map[string]any{
		"repository_ids": []int64{numericRepositoryID},
		"permissions":    map[string]string{permission: "read"},
	})
	if err != nil {
		return nil, errors.New("encode GitHub installation token request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, i.apiURL+"/app/installations/"+installationID+"/access_tokens", bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("create GitHub installation token request")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+jwt)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := i.client.Do(request)
	if err != nil {
		return nil, errors.New("GitHub installation token request failed")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil {
		return nil, errors.New("read GitHub installation token response")
	}
	if len(responseBody) > 1<<20 {
		return nil, errors.New("GitHub installation token response exceeds size limit")
	}
	if response.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("GitHub installation token request returned status %d", response.StatusCode)
	}
	var payload struct {
		Token        string    `json:"token"`
		ExpiresAt    time.Time `json:"expires_at"`
		Repositories []struct {
			ID int64 `json:"id"`
		} `json:"repositories"`
		Permissions map[string]string `json:"permissions"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return nil, errors.New("GitHub installation token response is invalid")
	}
	if strings.TrimSpace(payload.Token) == "" || len(payload.Token) > 4096 || strings.ContainsAny(payload.Token, "\r\n\x00") {
		return nil, errors.New("GitHub installation token response contains no token")
	}
	if !payload.ExpiresAt.After(now.Add(time.Minute)) || payload.ExpiresAt.After(now.Add(65*time.Minute)) {
		return nil, errors.Join(errors.New("GitHub installation token expiry is outside the allowed short-lived window"), revokeGitHubToken(ctx, i, payload.Token))
	}
	if len(payload.Repositories) != 1 || payload.Repositories[0].ID != numericRepositoryID {
		return nil, errors.Join(errors.New("GitHub installation token response does not prove exact-repository scope"), revokeGitHubToken(ctx, i, payload.Token))
	}
	if verifyPermission && (len(payload.Permissions) != 1 || payload.Permissions[permission] != "read") {
		return nil, errors.Join(errors.New("GitHub installation token response does not prove pull-request read scope"), revokeGitHubToken(ctx, i, payload.Token))
	}
	return &GitHubRepositoryCredential{Token: payload.Token, InstallationID: installationID, RepositoryID: repositoryID, UpstreamExpiresAt: payload.ExpiresAt.UTC()}, nil
}

func (i *gitHubAppCredentialIssuer) RevokeRepositoryCredential(ctx context.Context, token string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, i.apiURL+"/installation/token", nil)
	if err != nil {
		return errors.New("create GitHub token revocation request")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := i.client.Do(request)
	if err != nil {
		return errors.New("GitHub token revocation transport failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return errors.New("GitHub token revocation was not acknowledged")
	}
	return nil
}

func (i *gitHubAppCredentialIssuer) signJWT(now time.Time) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(9 * time.Minute).Unix(), "iss": i.appID})
	if err != nil {
		return "", errors.New("encode GitHub App JWT")
	}
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, i.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", errors.New("sign GitHub App JWT")
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func parseGitHubAppPrivateKey(value []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(value)
	if block == nil {
		return nil, errors.New("GitHub App private key file contains no PEM key")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("GitHub App private key file contains an invalid RSA key")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("GitHub App private key must be RSA")
	}
	return key, nil
}
