package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL             string
	Kubeconfig              string
	KubeContext             string
	StateFile               string
	OutputDir               string
	BaseDomain              string
	IngressGatewayNamespace string
	IngressClassName        string
	IngressCustomHTTPErrors string
	IngressErrorMiddleware  string
	DryRun                  bool
	Timeout                 time.Duration
	PollInterval            time.Duration
	ClaimLease              time.Duration
	WorkerID                string
}

func FromEnv() Config {
	timeout := 10 * time.Minute
	if value := os.Getenv("RAIBITSERVER_ROLLOUT_TIMEOUT_SECONDS"); value != "" {
		if parsed, err := time.ParseDuration(value + "s"); err == nil {
			timeout = parsed
		}
	}
	pollInterval := secondsEnv("RAIBITSERVER_RECONCILE_INTERVAL_SECONDS", 5*time.Second)
	claimLease := secondsEnv("RAIBITSERVER_CLAIM_LEASE_SECONDS", 15*time.Minute)
	hostname, _ := os.Hostname()
	return Config{
		DatabaseURL:             firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_DATABASE_URL"), os.Getenv("DATABASE_URL")),
		Kubeconfig:              os.Getenv("KUBECONFIG"),
		KubeContext:             os.Getenv("RAIBITSERVER_KUBE_CONTEXT"),
		StateFile:               firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_FILE"), os.Getenv("RAIBITSERVER_STATE_FILE"), os.Getenv("RAIBITSERVER_WORKFLOW_STATE")),
		OutputDir:               firstNonEmpty(os.Getenv("RAIBITSERVER_ORCHESTRATOR_OUTPUT_DIR"), ".raibitserver-work/orchestrator"),
		BaseDomain:              firstNonEmpty(os.Getenv("BASE_DOMAIN"), os.Getenv("RAIBITSERVER_BASE_DOMAIN"), "raibitserver.local"),
		IngressGatewayNamespace: firstNonEmpty(os.Getenv("RAIBITSERVER_INGRESS_GATEWAY_NAMESPACE"), "ingress-nginx"),
		IngressClassName:        firstNonEmpty(os.Getenv("RAIBITSERVER_INGRESS_CLASS_NAME"), "nginx"),
		IngressCustomHTTPErrors: ingressCustomHTTPErrorsFromEnv(),
		IngressErrorMiddleware:  os.Getenv("RAIBITSERVER_INGRESS_ERROR_MIDDLEWARE"),
		DryRun:                  os.Getenv("RAIBITSERVER_DRY_RUN") != "0" && os.Getenv("RAIBITSERVER_EXECUTE") != "1",
		Timeout:                 timeout,
		PollInterval:            pollInterval,
		ClaimLease:              claimLease,
		WorkerID:                firstNonEmpty(os.Getenv("RAIBITSERVER_WORKER_ID"), hostname, "raibitserver-orchestrator"),
	}
}

func ingressCustomHTTPErrorsFromEnv() string {
	value, configured := os.LookupEnv("RAIBITSERVER_INGRESS_CUSTOM_HTTP_ERRORS")
	if !configured {
		return "500,502,503,504"
	}
	if strings.TrimSpace(value) == "" {
		return "disabled"
	}
	return value
}

func secondsEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
