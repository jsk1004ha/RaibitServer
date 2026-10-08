package kube

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/raibitserver/orchestrator/internal/store"
)

func devNamespace(environmentID string) string {
	sum := sha256.Sum256([]byte(environmentID))
	return "rb-dev-" + hex.EncodeToString(sum[:])[:20]
}

func devPhysicalName(environmentID, logicalSlug string) string {
	sum := sha256.Sum256([]byte(environmentID + ":" + logicalSlug))
	prefix := "dev-" + hex.EncodeToString(sum[:])[:10] + "-"
	suffix := normalizeDNSName(logicalSlug)
	if len(suffix) > 63-len(prefix) {
		suffix = suffix[:63-len(prefix)]
	}
	suffix = strings.TrimRight(suffix, "-")
	if suffix == "" {
		suffix = "item"
	}
	return prefix + suffix
}

func environmentLabels(spec AppServiceSpec, labels map[string]any) map[string]any {
	if spec.EnvironmentKind == string(store.EnvironmentKindDev) {
		labels["raibitserver.io/environment-id"] = spec.EnvironmentID
		labels["raibitserver.io/environment-kind"] = string(store.EnvironmentKindDev)
	}
	return labels
}
