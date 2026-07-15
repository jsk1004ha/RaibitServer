package ingester

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"
)

func TestParseKubernetesQuantity(t *testing.T) {
	tests := []struct {
		value string
		want  float64
	}{
		{"250m", .25}, {"1000000n", .001}, {"1500u", .0015}, {"1", 1},
		{"1Ki", 1024}, {"2Mi", 2 * 1024 * 1024}, {"1.5Gi", 1.5 * 1024 * 1024 * 1024}, {"3M", 3_000_000},
	}
	for _, tc := range tests {
		got, err := ParseQuantity(tc.value)
		if err != nil || math.Abs(got-tc.want) > 0.000001 {
			t.Fatalf("ParseQuantity(%q)=%v,%v want %v", tc.value, got, err, tc.want)
		}
	}
	if _, err := ParseQuantity("not-a-quantity"); err == nil {
		t.Fatal("invalid quantity was accepted")
	}
}

func TestRunOncePersistsOnlyTruthfulBoundedCPUAndMemory(t *testing.T) {
	now := time.Date(2026, 7, 13, 4, 0, 0, 0, time.UTC)
	source := &fakeSource{pods: []PodMetrics{{
		Namespace: "org--project", Name: "web-abc", UID: "pod-uid", Timestamp: now,
		Labels:     map[string]string{"raibitserver.io/service-id": "svc-1", "raibitserver.io/deployment-id": "dep-1"},
		Containers: []ContainerMetrics{{Name: "app", CPU: "250m", Memory: "64Mi"}, {Name: "sidecar", CPU: "10m", Memory: "8Mi"}},
	}}}
	state := &fakeStore{}
	result, err := New(Config{PageSize: 10, MaxPods: 10, MaxContainersPerPod: 1, Retention: 48 * time.Hour}, source, state).RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pods != 1 || result.Samples != 2 || result.Inserted != 2 {
		t.Fatalf("unexpected bounded result: %#v", result)
	}
	if len(state.records) != 2 || state.records[0].Metric != "cpu" || state.records[1].Metric != "memory" {
		t.Fatalf("unexpected metrics: %#v", state.records)
	}
	if state.records[0].Value != .25 || state.records[0].Unit != "cores" || state.records[1].Value != 64*1024*1024 || state.records[1].Unit != "bytes" {
		t.Fatalf("quantity normalization failed: %#v", state.records)
	}
	for _, record := range state.records {
		if record.ServiceID != "svc-1" || record.SourceKey == "" {
			t.Fatalf("identity/dedupe key missing: %#v", record)
		}
	}
	if !state.retentionBefore.Equal(now.Add(-48 * time.Hour)) {
		t.Fatalf("retention cutoff mismatch: %s", state.retentionBefore)
	}
}

func TestRunOnceFailsClosedWithoutAdvancingOnDatabaseError(t *testing.T) {
	now := time.Now().UTC()
	source := &fakeSource{pods: []PodMetrics{{Namespace: "ns", Name: "pod", UID: "uid", Timestamp: now, Labels: map[string]string{"raibitserver.io/service-id": "svc"}, Containers: []ContainerMetrics{{Name: "app", CPU: "1m", Memory: "1Mi"}}}}}
	state := &fakeStore{insertErr: errors.New("database unavailable")}
	_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	if err == nil || len(state.records) != 0 {
		t.Fatalf("database error was ignored: err=%v records=%#v", err, state.records)
	}
}

func TestRunOnceEnforcesGlobalSampleBudgetAcrossPods(t *testing.T) {
	now := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	pods := make([]PodMetrics, 0, 3)
	for _, id := range []string{"one", "two", "three"} {
		pods = append(pods, PodMetrics{Name: id, UID: id, Timestamp: now, Labels: map[string]string{serviceLabel: "svc-" + id}, Containers: []ContainerMetrics{{Name: "app", CPU: "1m", Memory: "1Mi"}, {Name: "sidecar", CPU: "2m", Memory: "2Mi"}}})
	}
	state := &fakeStore{}
	result, err := New(Config{MaxSamplesPerRun: 4}, &fakeSource{pods: pods}, state).RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Samples != 4 || len(state.records) != 4 || state.insertCalls != 1 {
		t.Fatalf("sample budget exceeded: result=%#v records=%#v", result, state.records)
	}
	if state.records[0].PodUID == state.records[2].PodUID {
		t.Fatalf("one pod consumed the entire run budget: %#v", state.records)
	}
}

type fakeSource struct{ pods []PodMetrics }

func (f *fakeSource) ListPodMetrics(_ context.Context, _ string, limit int) ([]PodMetrics, string, error) {
	if limit <= 0 || limit >= len(f.pods) {
		return f.pods, "", nil
	}
	return f.pods[:limit], "next", nil
}

type fakeStore struct {
	records         []Record
	insertErr       error
	retentionBefore time.Time
	insertCalls     int
}

func (f *fakeStore) Insert(_ context.Context, records []Record) (int, error) {
	f.insertCalls++
	if f.insertErr != nil {
		return 0, f.insertErr
	}
	f.records = append(f.records, records...)
	return len(records), nil
}

func (f *fakeStore) DeleteOlderThan(_ context.Context, before time.Time) (int64, error) {
	f.retentionBefore = before
	return 0, nil
}
