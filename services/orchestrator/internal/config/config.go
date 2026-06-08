package config

import (
	"os"
	"time"
)

type Config struct {
	DatabaseURL string
	Kubeconfig  string
	KubeContext string
	StateFile   string
	OutputDir   string
	BaseDomain  string
	DryRun      bool
	Timeout     time.Duration
}

func FromEnv() Config {
	timeout := 10 * time.Minute
	if value := os.Getenv("RAIBITSERVER_ROLLOUT_TIMEOUT_SECONDS"); value != "" {
		if parsed, err := time.ParseDuration(value + "s"); err == nil {
			timeout = parsed
		}
	}
	return Config{
		DatabaseURL: os.Getenv("DATABASE_URL"),
		Kubeconfig:  os.Getenv("KUBECONFIG"),
		KubeContext: os.Getenv("RAIBITSERVER_KUBE_CONTEXT"),
		StateFile:   firstNonEmpty(os.Getenv("RAIBITSERVER_CONTROL_PLANE_FILE"), os.Getenv("RAIBITSERVER_STATE_FILE"), os.Getenv("RAIBITSERVER_WORKFLOW_STATE")),
		OutputDir:   firstNonEmpty(os.Getenv("RAIBITSERVER_ORCHESTRATOR_OUTPUT_DIR"), ".raibitserver-work/orchestrator"),
		BaseDomain:  firstNonEmpty(os.Getenv("BASE_DOMAIN"), os.Getenv("RAIBITSERVER_BASE_DOMAIN"), "raibitserver.local"),
		DryRun:      os.Getenv("RAIBITSERVER_DRY_RUN") != "0" && os.Getenv("RAIBITSERVER_EXECUTE") != "1",
		Timeout:     timeout,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
