package kube

import (
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

	"github.com/raibitserver/metrics-ingester/internal/ingester"
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
		ca, readErr := os.ReadFile(filepath.Clean(firstNonEmpty(os.Getenv("RAIBITSERVER_KUBERNETES_CA_FILE"), "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")))
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

func (c *Client) ListPodMetrics(ctx context.Context, continueToken string, limit int) ([]ingester.PodMetrics, string, error) {
	query := url.Values{"labelSelector": {workloadSelector}, "limit": {fmt.Sprint(limit)}}
	if continueToken != "" {
		query.Set("continue", continueToken)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/apis/metrics.k8s.io/v1beta1/pods?"+query.Encode(), nil)
	if err != nil {
		return nil, "", err
	}
	token, err := c.bearerToken()
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, "", fmt.Errorf("Kubernetes metrics API returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var payload metricsList
	if err := json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&payload); err != nil {
		return nil, "", fmt.Errorf("decode Kubernetes metrics response: %w", err)
	}
	items := make([]ingester.PodMetrics, 0, len(payload.Items))
	for _, item := range payload.Items {
		at, parseErr := time.Parse(time.RFC3339Nano, item.Timestamp)
		if parseErr != nil {
			continue
		}
		containers := make([]ingester.ContainerMetrics, 0, len(item.Containers))
		for _, container := range item.Containers {
			containers = append(containers, ingester.ContainerMetrics{Name: container.Name, CPU: container.Usage.CPU, Memory: container.Usage.Memory})
		}
		items = append(items, ingester.PodMetrics{Namespace: item.Metadata.Namespace, Name: item.Metadata.Name, UID: item.Metadata.UID, Labels: item.Metadata.Labels, Timestamp: at, Containers: containers})
	}
	return items, payload.Metadata.Continue, nil
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

type metricsList struct {
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
		Timestamp  string `json:"timestamp"`
		Containers []struct {
			Name  string `json:"name"`
			Usage struct {
				CPU    string `json:"cpu"`
				Memory string `json:"memory"`
			} `json:"usage"`
		} `json:"containers"`
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
