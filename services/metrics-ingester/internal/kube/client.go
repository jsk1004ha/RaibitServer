package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
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
			return nil, &ingester.Failure{Code: "configuration"}
		}
		baseURL = "https://" + host + ":" + port
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return nil, &ingester.Failure{Code: "configuration"}
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		return nil, &ingester.Failure{Code: "configuration"}
	}
	staticToken := strings.TrimSpace(os.Getenv("RAIBITSERVER_KUBERNETES_TOKEN"))
	tokenFile := ""
	if staticToken == "" {
		tokenFile = filepath.Clean(firstNonEmpty(os.Getenv("RAIBITSERVER_KUBERNETES_TOKEN_FILE"), "/var/run/secrets/kubernetes.io/serviceaccount/token"))
		payload, readErr := os.ReadFile(tokenFile)
		if readErr != nil {
			return nil, &ingester.Failure{Code: "configuration"}
		}
		if strings.TrimSpace(string(payload)) == "" {
			return nil, &ingester.Failure{Code: "configuration"}
		}
	}
	if staticToken == "" && tokenFile == "" {
		return nil, &ingester.Failure{Code: "configuration"}
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if parsed.Scheme == "https" {
		ca, readErr := os.ReadFile(filepath.Clean(firstNonEmpty(os.Getenv("RAIBITSERVER_KUBERNETES_CA_FILE"), "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")))
		if readErr != nil {
			return nil, &ingester.Failure{Code: "configuration"}
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(ca) {
			return nil, &ingester.Failure{Code: "configuration"}
		}
		tlsConfig.RootCAs = roots
	}
	return &Client{baseURL: baseURL, staticToken: staticToken, tokenFile: tokenFile, http: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{TLSClientConfig: tlsConfig, MaxIdleConns: 10, MaxIdleConnsPerHost: 5, ResponseHeaderTimeout: 10 * time.Second, MaxResponseHeaderBytes: 16384}}}, nil
}

func (c *Client) ListPodMetrics(ctx context.Context, continueToken string, limit int) ([]ingester.PodMetrics, string, error) {
	if len(continueToken) > 4096 || limit < 1 || limit > 500 {
		return nil, "", &ingester.Failure{Code: "field_limit"}
	}
	query := url.Values{"labelSelector": {workloadSelector}, "limit": {fmt.Sprint(limit)}}
	if continueToken != "" {
		query.Set("continue", continueToken)
	}
	var payload metricsList
	if err := c.get(ctx, "/apis/metrics.k8s.io/v1beta1/pods?"+query.Encode(), &payload); err != nil {
		return nil, "", err
	}
	if len(payload.Items) > limit || len(payload.Metadata.Continue) > 4096 {
		return nil, "", &ingester.Failure{Code: "field_limit"}
	}
	items := make([]ingester.PodMetrics, 0, len(payload.Items))
	for _, item := range payload.Items {
		if !validName(item.Metadata.Namespace, 63) || !validName(item.Metadata.Name, 253) || len(item.Metadata.UID) > 128 || len(item.Metadata.Labels) > 64 || len(item.Containers) > 32 || len(item.Timestamp) > 64 {
			return nil, "", &ingester.Failure{Code: "field_limit"}
		}
		for key, value := range item.Metadata.Labels {
			if len(key) > 253 || len(value) > 256 {
				return nil, "", &ingester.Failure{Code: "field_limit"}
			}
		}
		at, parseErr := time.Parse(time.RFC3339Nano, item.Timestamp)
		if parseErr != nil {
			continue
		}
		containers := make([]ingester.ContainerMetrics, 0, len(item.Containers))
		for _, container := range item.Containers {
			if !validName(container.Name, 63) || len(container.Usage.CPU) > 64 || len(container.Usage.Memory) > 64 {
				return nil, "", &ingester.Failure{Code: "field_limit"}
			}
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
		return "", &ingester.Failure{Code: "configuration"}
	}
	payload, err := os.ReadFile(filepath.Clean(c.tokenFile))
	if err != nil {
		return "", &ingester.Failure{Code: "configuration"}
	}
	token := strings.TrimSpace(string(payload))
	if token == "" {
		return "", &ingester.Failure{Code: "configuration"}
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
