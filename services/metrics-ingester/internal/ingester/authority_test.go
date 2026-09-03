package ingester

import (
	"context"
	"testing"
	"time"
)

func TestIdentityRejectsUnverifiedLabelOnlySource(t *testing.T) {
	// Given: untrusted metrics claim a deployment with no authoritative resolver.
	now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	source := &fakeSource{pods: []PodMetrics{{Namespace: "foreign", Name: "pod", UID: "uid", Timestamp: now, Labels: map[string]string{serviceLabel: "victim", deploymentLabel: "deployment"}, Containers: []ContainerMetrics{{Name: "app", CPU: "1", Memory: "1Mi"}}}}}
	source.deny = true
	state := &fakeStore{}
	// When: the ordinary worker processes the source.
	_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	// Then: no label-only data reaches persistence.
	if err != nil || len(state.records) != 0 {
		t.Fatalf("unverified source persisted: err=%v rows=%d", err, len(state.records))
	}
}
