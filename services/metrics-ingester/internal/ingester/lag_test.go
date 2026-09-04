package ingester

import (
	"testing"
	"time"
)

func TestLagIsMeasuredAtPersistenceAndFutureSkewClamped(t *testing.T) {
	for _, tc := range []struct {
		name   string
		offset time.Duration
		want   float64
	}{{"persistence_time", -time.Second, 6}, {"future_allowed", 30 * time.Second, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			// Given: event time and an injected clock five seconds after run start.
			now := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
			source := &fakeSource{pods: []PodMetrics{{Namespace: "ns", Name: "pod", UID: "uid", Timestamp: now.Add(tc.offset), Labels: map[string]string{deploymentLabel: "deployment"}, Containers: []ContainerMetrics{{Name: "app", CPU: "1", Memory: "1Mi"}}}}}
			state := &fakeStore{}
			// When: the batch reaches successful persistence.
			out, err := New(Config{Now: func() time.Time { return now.Add(5 * time.Second) }}, source, state).RunOnce(t.Context(), now)
			// Then: event age includes ingestion time and never becomes negative.
			if err != nil || !out.Observed || out.LagSeconds != tc.want {
				t.Fatalf("lag=%#v err=%v", out, err)
			}
		})
	}
}
