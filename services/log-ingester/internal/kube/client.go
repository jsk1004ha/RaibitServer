package kube

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
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

	"github.com/raibitserver/log-ingester/internal/ingester"
)

const workloadSelector = "app.kubernetes.io/managed-by=raibitserver"

type Client struct {
	baseURL     string
	staticToken string
	tokenFile   string
	http        *http.Client
}

func NewFromEnvironment() (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("RAIBITSERVER_KUBERNETES_API")), "/")
	if baseURL == "" {
		host := strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST"))
		port := firstNonEmpty(os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS"), os.Getenv("KUBERNETES_SERVICE_PORT"), "443")
		if host == "" {
			return nil, errors.New("Kubernetes API endpoint is required")
		}
		baseURL = "https://" + host + ":" + port
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Kubernetes API endpoint %q", baseURL)
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		return nil, errors.New("Kubernetes API endpoint must use HTTPS")
	}
	staticToken := strings.TrimSpace(os.Getenv("RAIBITSERVER_KUBERNETES_TOKEN"))
	tokenFile := ""
	if staticToken == "" {
		tokenFile = filepath.Clean(firstNonEmpty(os.Getenv("RAIBITSERVER_KUBERNETES_TOKEN_FILE"), "/var/run/secrets/kubernetes.io/serviceaccount/token"))
		payload, readErr := os.ReadFile(tokenFile)
		if readErr != nil {
			return nil, fmt.Errorf("read Kubernetes service-account token: %w", readErr)
		}
		if strings.TrimSpace(string(payload)) == "" {
			return nil, errors.New("Kubernetes service-account token is empty")
		}
	}
	if staticToken == "" && tokenFile == "" {
		return nil, errors.New("Kubernetes service-account token is empty")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if parsed.Scheme == "https" {
		caPath := firstNonEmpty(os.Getenv("RAIBITSERVER_KUBERNETES_CA_FILE"), "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
		ca, readErr := os.ReadFile(filepath.Clean(caPath))
		if readErr != nil {
			return nil, fmt.Errorf("read Kubernetes CA: %w", readErr)
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(ca) {
			return nil, errors.New("Kubernetes CA contains no valid certificate")
		}
		tlsConfig.RootCAs = roots
	}
	return &Client{baseURL: baseURL, staticToken: staticToken, tokenFile: tokenFile, http: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsConfig}}}, nil
}

func (c *Client) ListPods(ctx context.Context, continueToken string, limit int) ([]ingester.Pod, string, error) {
	query := url.Values{"labelSelector": {workloadSelector}, "limit": {fmt.Sprint(limit)}}
	if continueToken != "" {
		query.Set("continue", continueToken)
	}
	var response podList
	if err := c.getJSON(ctx, "/api/v1/pods?"+query.Encode(), &response); err != nil {
		return nil, "", err
	}
	pods := make([]ingester.Pod, 0, len(response.Items))
	for _, item := range response.Items {
		containers := make([]string, 0, len(item.Spec.Containers))
		for _, container := range item.Spec.Containers {
			containers = append(containers, container.Name)
		}
		pods = append(pods, ingester.Pod{Namespace: item.Metadata.Namespace, Name: item.Metadata.Name, UID: item.Metadata.UID, Labels: item.Metadata.Labels, Containers: containers})
	}
	return pods, response.Metadata.Continue, nil
}

func (c *Client) ReadLogs(ctx context.Context, pod ingester.Pod, container string, since time.Time, limitBytes int64) ([]ingester.LogEntry, error) {
	query := url.Values{"container": {container}, "timestamps": {"true"}, "limitBytes": {fmt.Sprint(limitBytes)}}
	if !since.IsZero() {
		query.Set("sinceTime", since.UTC().Format(time.RFC3339Nano))
	}
	path := "/api/v1/namespaces/" + url.PathEscape(pod.Namespace) + "/pods/" + url.PathEscape(pod.Name) + "/log?" + query.Encode()
	response, err := c.request(ctx, path)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	entries := []ingester.LogEntry{}
	reader := bufio.NewReaderSize(io.LimitReader(response.Body, limitBytes+1), 64*1024)
	for {
		lineBytes, readErr := reader.ReadBytes('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, fmt.Errorf("read Kubernetes logs: %w", readErr)
		}
		if len(lineBytes) > 0 && lineBytes[len(lineBytes)-1] == '\n' {
			lineBytes = bytes.TrimSuffix(lineBytes, []byte{'\n'})
			lineBytes = bytes.TrimSuffix(lineBytes, []byte{'\r'})
			if len(lineBytes) > 64*1024 {
				lineBytes = lineBytes[:64*1024]
			}
			line := strings.ReplaceAll(strings.ToValidUTF8(string(lineBytes), ""), "\x00", "")
			separator := strings.IndexByte(line, ' ')
			if separator > 0 {
				at, parseErr := time.Parse(time.RFC3339Nano, line[:separator])
				if parseErr == nil {
					entries = append(entries, ingester.LogEntry{Timestamp: at, Line: line[separator+1:]})
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	return entries, nil
}

func (c *Client) getJSON(ctx context.Context, path string, target any) error {
	response, err := c.request(ctx, path)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024))
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode Kubernetes response: %w", err)
	}
	return nil
}

func (c *Client) request(ctx context.Context, path string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	token, err := c.bearerToken()
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, &StatusError{Code: response.StatusCode, Status: response.Status, Body: strings.TrimSpace(string(body))}
	}
	return response, nil
}

func (c *Client) bearerToken() (string, error) {
	if strings.TrimSpace(c.staticToken) != "" {
		return strings.TrimSpace(c.staticToken), nil
	}
	if c.tokenFile == "" {
		return "", errors.New("Kubernetes service-account token is empty")
	}
	payload, err := os.ReadFile(filepath.Clean(c.tokenFile))
	if err != nil {
		return "", fmt.Errorf("read Kubernetes service-account token: %w", err)
	}
	token := strings.TrimSpace(string(payload))
	if token == "" {
		return "", errors.New("Kubernetes service-account token is empty")
	}
	return token, nil
}

type StatusError struct {
	Code   int
	Status string
	Body   string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("Kubernetes API returned %s: %s", e.Status, e.Body)
}

func (e *StatusError) SkipContainer() bool {
	return e.Code == http.StatusBadRequest || e.Code == http.StatusNotFound || e.Code == http.StatusGone
}

type podList struct {
	Metadata struct {
		Continue string `json:"continue"`
	} `json:"metadata"`
	Items []struct {
		Metadata struct {
			Namespace string            `json:"namespace"`
			Name      string            `json:"name"`
			UID       string            `json:"uid"`
			Labels    map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			Containers []struct {
				Name string `json:"name"`
			} `json:"containers"`
		} `json:"spec"`
	} `json:"items"`
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
