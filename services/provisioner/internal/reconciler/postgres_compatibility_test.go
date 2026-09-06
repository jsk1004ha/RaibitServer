package reconciler

import (
	"os"
	"strings"
	"testing"
)

func TestPostgresCompatibility(t *testing.T) {
	if strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN")) == "" {
		t.Skip("NOT_RUN: RAIBITSERVER_TEST_POSTGRES_DSN is not configured")
	}
	t.Run("resource claim and state write", TestPostgresReadyProviderReplacementTransitionsToFailed)
}
