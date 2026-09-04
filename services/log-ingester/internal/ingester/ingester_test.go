package ingester

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	redaction "github.com/raibitserver/log-ingester/internal/redact"
)

func TestRunOncePersistsBoundedRedactedLogsAndCursor(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC)
	source := &fakeSource{pods: []Pod{{
		Namespace: "org--project", Name: "web-abc", UID: "pod-uid", Containers: []string{"app", "sidecar"},
		Labels: map[string]string{"raibitserver.io/service-id": "svc-1", "raibitserver.io/deployment-id": "dep-1"},
	}}}
	source.logs = map[string][]LogEntry{
		"app": {
			{Timestamp: now.Add(-time.Second), Line: "ready token=secret-value"},
			{Timestamp: now, Line: strings.Repeat("x", 300)},
		},
		"sidecar": {{Timestamp: now, Line: "ignored by container bound"}},
	}
	state := &fakeStore{}
	worker := New(Config{PageSize: 10, MaxPods: 10, MaxContainersPerPod: 1, MaxLinesPerContainer: 1, MaxLineBytes: 64, Retention: 24 * time.Hour}, source, state)

	result, err := worker.RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pods != 1 || result.Containers != 1 || result.Inserted != 1 {
		t.Fatalf("unexpected bounded result: %#v", result)
	}
	if len(state.records) != 1 || strings.Contains(state.records[0].Line, "secret-value") || len(state.records[0].Line) > 64 {
		t.Fatalf("log was not bounded/redacted: %#v", state.records)
	}
	if state.records[0].ServiceID != "svc-1" || state.records[0].DeploymentID != "dep-1" || state.records[0].SourceKey == "" {
		t.Fatalf("workload identity/dedupe key missing: %#v", state.records[0])
	}
	if state.cursors["logs:pod-uid:app"].IsZero() {
		t.Fatalf("cursor was not advanced: %#v", state.cursors)
	}
	if !state.retentionBefore.Equal(now.Add(-24 * time.Hour)) {
		t.Fatalf("retention cutoff mismatch: %s", state.retentionBefore)
	}
}

func TestRunOnceSkipsUnscopedPodsAndStopsAtPageBound(t *testing.T) {
	source := &fakeSource{pods: []Pod{
		{Namespace: "ns", Name: "foreign", UID: "foreign", Containers: []string{"app"}},
		{Namespace: "ns", Name: "owned", UID: "owned", Containers: []string{"app"}, Labels: map[string]string{"raibitserver.io/service-id": "svc"}},
		{Namespace: "ns", Name: "over-limit", UID: "later", Containers: []string{"app"}, Labels: map[string]string{"raibitserver.io/service-id": "svc"}},
	}}
	source.logs = map[string][]LogEntry{"app": {{Timestamp: time.Now().UTC(), Line: "ok"}}}
	state := &fakeStore{}
	result, err := New(Config{PageSize: 1, MaxPods: 1}, source, state).RunOnce(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if result.Pods > 1 || len(state.records) > 1 {
		t.Fatalf("pod bound was exceeded: result=%#v records=%d", result, len(state.records))
	}
}

func TestRunOnceDoesNotAdvanceCursorWhenInsertFails(t *testing.T) {
	now := time.Now().UTC()
	source := &fakeSource{pods: []Pod{{Namespace: "ns", Name: "pod", UID: "uid", Containers: []string{"app"}, Labels: map[string]string{"raibitserver.io/service-id": "svc"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: "ok"}}}}
	state := &fakeStore{insertErr: errors.New("database unavailable")}
	_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	if err == nil || len(state.cursors) != 0 {
		t.Fatalf("failed insert advanced cursor: err=%v cursors=%#v", err, state.cursors)
	}
}

func TestRedactCoversStructuredAuthorizationAndJWTSecrets(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue"
	input := `{"password":"json-secret","token": "token-secret", "api_key":"escaped-\\\"secret"} Authorization: Bearer bearer-secret session=` + jwt + ` postgres://user:db-secret@db/app`
	redacted := redaction.Text(input)
	for _, secret := range []string{"json-secret", "token-secret", "escaped", "bearer-secret", "signaturevalue", "db-secret"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("secret %q remained in %q", secret, redacted)
		}
	}
}

func TestRunOnceEnforcesGlobalFairRecordAndByteBudgets(t *testing.T) {
	now := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	source := &fakeSource{pods: []Pod{{Name: "one", UID: "one", Containers: []string{"one"}, Labels: map[string]string{serviceLabel: "svc-1"}}, {Name: "two", UID: "two", Containers: []string{"two"}, Labels: map[string]string{serviceLabel: "svc-2"}}, {Name: "three", UID: "three", Containers: []string{"three"}, Labels: map[string]string{serviceLabel: "svc-3"}}}, logs: map[string][]LogEntry{}}
	for _, container := range []string{"one", "two", "three"} {
		source.logs[container] = []LogEntry{{Timestamp: now, Line: "1234567890"}, {Timestamp: now.Add(time.Second), Line: "abcdefghij"}}
	}
	state := &fakeStore{scopes: map[string]identity.Scope{"dep:svc-1": {ServiceID: "svc-1", DeploymentID: "dep:svc-1", Container: "one"}, "dep:svc-2": {ServiceID: "svc-2", DeploymentID: "dep:svc-2", Container: "two"}, "dep:svc-3": {ServiceID: "svc-3", DeploymentID: "dep:svc-3", Container: "three"}}}
	result, err := New(Config{MaxRecordsPerRun: 2, MaxBytesPerRun: 20, MaxLineBytes: 10}, source, state).RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.records) != 2 || result.Inserted != 2 || state.insertCalls != 1 {
		t.Fatalf("global record budget exceeded: result=%#v records=%#v", result, state.records)
	}
	if state.records[0].ContainerName == state.records[1].ContainerName {
		t.Fatalf("one container consumed the whole run budget: %#v", state.records)
	}
}

func TestRunOnceSkipsGonePodLogAndContinues(t *testing.T) {
	now := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	source := &fakeSource{
		pods:     []Pod{{Name: "gone", UID: "gone", Containers: []string{"gone"}, Labels: map[string]string{serviceLabel: "gone"}}, {Name: "healthy", UID: "healthy", Containers: []string{"healthy"}, Labels: map[string]string{serviceLabel: "healthy"}}},
		logs:     map[string][]LogEntry{"healthy": {{Timestamp: now, Line: "ready"}}},
		readErrs: map[string]error{"gone": skippableReadError{}},
	}
	state := &fakeStore{scopes: map[string]identity.Scope{"dep:gone": {ServiceID: "gone", DeploymentID: "dep:gone", Container: "gone"}, "dep:healthy": {ServiceID: "healthy", DeploymentID: "dep:healthy", Container: "healthy"}}}
	result, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Inserted != 1 || len(state.records) != 1 || state.records[0].ContainerName != "healthy" {
		t.Fatalf("healthy container was not ingested after a gone pod error: %#v %#v", result, state.records)
	}
}

type skippableReadError struct{}

func (skippableReadError) Error() string       { return "pod is gone" }
func (skippableReadError) SkipContainer() bool { return true }

type fakeSource struct {
	pods     []Pod
	logs     map[string][]LogEntry
	readErrs map[string]error
}

func (f *fakeSource) ListPods(_ context.Context, _ string, limit int) ([]Pod, string, error) {
	for index := range f.pods {
		if f.pods[index].Labels[serviceLabel] != "" && f.pods[index].Labels[deploymentLabel] == "" {
			f.pods[index].Labels[deploymentLabel] = "dep:" + f.pods[index].Labels[serviceLabel]
		}
	}
	if limit <= 0 || limit >= len(f.pods) {
		return f.pods, "", nil
	}
	return f.pods[:limit], "next", nil
}

func (f *fakeSource) ReadLogs(_ context.Context, _ Pod, container string, _ time.Time, _ int64) ([]LogEntry, error) {
	if err := f.readErrs[container]; err != nil {
		return nil, err
	}
	return f.logs[container], nil
}

type fakeStore struct {
	records         []Record
	cursors         map[string]time.Time
	insertErr       error
	retentionBefore time.Time
	insertCalls     int
	states          map[string]string
	scopes          map[string]identity.Scope
}

func (f *fakeStore) Cursor(_ context.Context, key string) (time.Time, error) {
	return f.cursors[key], nil
}

func (f *fakeStore) Insert(_ context.Context, records []Record, cursors []CursorUpdate) (int, error) {
	f.insertCalls++
	if f.insertErr != nil {
		return 0, f.insertErr
	}
	inserted := 0
	for _, record := range records {
		found := false
		for _, old := range f.records {
			if old.SourceKey == record.SourceKey {
				found = true
			}
		}
		if !found {
			f.records = append(f.records, record)
			inserted++
		}
	}
	if f.cursors == nil {
		f.cursors = map[string]time.Time{}
	}
	if f.states == nil {
		f.states = map[string]string{}
	}
	for _, update := range cursors {
		f.states["logs-state:"+strings.TrimPrefix(update.Key, "logs:")] = update.State
		f.cursors[update.Key] = update.Cursor
	}
	return inserted, nil
}

func (f *fakeStore) DeleteOlderThan(_ context.Context, before time.Time) (int64, error) {
	f.retentionBefore = before
	return 0, nil
}

func (f *fakeSource) Verify(_ context.Context, _ Pod, _ identity.Scope) (time.Time, error) {
	return time.Unix(1, 0), nil
}

func (f *fakeStore) Resolve(_ context.Context, id string) (identity.Scope, error) {
	if scope, ok := f.scopes[id]; ok {
		return scope, nil
	}
	service := strings.TrimPrefix(id, "dep:")
	if id == "dep-1" {
		service = "svc-1"
	}
	return identity.Scope{ServiceID: service, DeploymentID: id, Container: "app"}, nil
}
func (f *fakeStore) State(_ context.Context, key string) (string, error) { return f.states[key], nil }
func (f *fakeStore) Existing(_ context.Context, keys []string) (map[string]bool, error) {
	found := map[string]bool{}
	for _, key := range keys {
		for _, row := range f.records {
			if key == row.SourceKey {
				found[key] = true
			}
		}
	}
	return found, nil
}
