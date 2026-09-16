package ingester

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/redact"
)

type discoveryDeadlineSource struct{ fakeSource }

func (discoveryDeadlineSource) ListPods(ctx context.Context, _ string, _ int) ([]Pod, string, error) {
	<-ctx.Done()
	return nil, "", ctx.Err()
}

type createdSource struct {
	fakeSource
	created time.Time
}

type truncatedSource struct{ fakeSource }

func (s *truncatedSource) ReadLogs(_ context.Context, _ Pod, container string, _ time.Time, _ int64) ([]LogEntry, error) {
	return s.logs[container], ErrSourceWindowLimited
}

func (s *createdSource) Verify(context.Context, Pod, identity.Scope) (time.Time, error) {
	return s.created, nil
}

func TestIngestionAdversarialTimestampWindow(t *testing.T) {
	now := time.Date(2026, 9, 3, 10, 0, 0, 123, time.UTC)
	for _, test := range []struct {
		name     string
		at       time.Time
		accepted bool
	}{
		{"current", now, true}, {"allowed_future", now.Add(30 * time.Second), true}, {"future_denied", now.Add(30*time.Second + time.Nanosecond), false}, {"before_creation", now.Add(-3 * time.Minute), false}, {"retention", now.Add(-8 * 24 * time.Hour), false}, {"zero", time.Time{}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given: timestamps straddle the verified Pod lifetime and retention/future windows.
			source := &createdSource{created: now.Add(-2 * time.Minute), fakeSource: fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: test.at, Line: "ready"}}}}}
			state := &fakeStore{}
			// When / Then: invalid time cannot persist or advance any cursor.
			result, err := New(Config{}, source, state).RunOnce(context.Background(), now)
			if err != nil || (result.Inserted == 1) != test.accepted || (!test.accepted && len(state.cursors) > 0) {
				t.Fatal("timestamp admission mismatch")
			}
			if test.name == "allowed_future" && result.LagSeconds != 0 {
				t.Fatal("future lag was not clamped")
			}
		})
	}
}

func TestIngestionAdversarialRedactionBeforeLineTruncation(t *testing.T) {
	// Given: v1 source hashing sees the bounded prefix, but a PEM header occurs after it.
	now := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: "prefix", RedactionInput: "prefix -----BEGIN PRIVATE KEY-----"}, {Timestamp: now.Add(time.Second), Line: "FORBIDDEN_BODY"}}}}
	state := &fakeStore{}
	// When / Then: continuation survives output truncation and masks the following source record.
	_, err := New(Config{MaxLineBytes: 4}, source, state).RunOnce(context.Background(), now)
	if err != nil || len(state.records) != 2 || state.records[1].Line != "****" {
		t.Fatal("truncated PEM continuation leaked")
	}
}

func TestIngestionHappyLagMeasuredAtPersistence(t *testing.T) {
	// Given: discovery/persistence consume 3s after the injected run-start time.
	now := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	ticks := 0
	clock := func() time.Time { ticks++; return now.Add(time.Duration(ticks-1) * 3 * time.Second) }
	source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now.Add(-2 * time.Second), Line: "ready"}}}}
	// When: a row is successfully persisted.
	result, err := New(Config{Clock: clock}, source, &fakeStore{}).RunOnce(context.Background(), now)
	// Then: lag includes time spent in this run and exposes the actual observation instant.
	if err != nil || result.LagSeconds != 5 || !result.ObservedAt.Equal(now.Add(3*time.Second)) {
		t.Fatal("persistence lag omitted run duration")
	}
}

func TestIngestionAdversarialDiscoveryConsumesDeadline(t *testing.T) {
	// Given: discovery waits until its context deadline.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	worker := New(Config{MaxRunDuration: time.Millisecond}, &discoveryDeadlineSource{}, &fakeStore{})
	// When: the whole run has a shorter deadline than the caller.
	_, err := worker.RunOnce(ctx, time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC))
	// Then: discovery is cancelled by the run, not by the outer caller.
	if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		t.Fatalf("discovery escaped the run deadline: run=%v parent=%v", err, ctx.Err())
	}
}

func TestIngestionAdversarialPasswordOnlyURL(t *testing.T) {
	// Given / When: a password-only Redis URL crosses the masking boundary.
	got := redact.Text("connected redis://:SYNTHETIC_PASSWORD@cache:6379/0")
	// Then: harmless connection context survives without credential bytes.
	if got != "connected redis://:****@cache:6379/0" {
		t.Fatal("password-only URL was not masked")
	}
}

func TestIngestionMasksPermanentlyWhenRedactionStateIsMissingAfterRestart(t *testing.T) {
	now := time.Date(2026, 9, 13, 1, 2, 3, 4, time.UTC)
	for _, test := range []struct{ name, checkpoint string }{
		{name: "missing"},
		{name: "mismatched watermark", checkpoint: `{"v":1,"pem":false,"sequence":1,"watermark":"2026-09-13T01:02:02.000000004Z"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given: a persisted source watermark lacks its matching atomic redaction checkpoint.
			source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: "ready"}}}}
			state := &fakeStore{cursors: map[string]time.Time{"logs:uid:app": now}, states: map[string]string{"logs-state:uid:app": test.checkpoint}}
			// When: collection restarts from the persisted watermark.
			_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
			// Then: missing parser context fails closed by persisting only a permanent mask.
			checkpoint := state.states["logs-state:uid:app"]
			if err != nil || state.insertCalls != 1 || len(state.records) != 1 || state.records[0].Line != "****" || !strings.Contains(checkpoint, `"uncertain":true`) || !strings.Contains(checkpoint, now.Format(time.RFC3339Nano)) {
				t.Fatalf("restart state was not fail-closed: err=%v records=%#v state=%q", err, state.records, checkpoint)
			}
			t.Logf("restart_checkpoint=%s pre_insert_line=%q", checkpoint, state.records[0].Line)
		})
	}
}

func TestIngestionRedactsBeforeStoreInsertAcrossRestart(t *testing.T) {
	// Given: a quoted environment secret is split across two bounded ingestion runs.
	now := time.Date(2026, 9, 13, 1, 2, 3, 4, time.UTC)
	source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: `POSTGRES_PASSWORD="FORBIDDEN_START`}, {Timestamp: now.Add(time.Nanosecond), Line: `FORBIDDEN_END" ready`}}}}
	state := &fakeStore{}
	worker := New(Config{MaxRecordsPerRun: 1, MaxLinesPerContainer: 1}, source, state)
	// When: two independent runs persist and reload the continuation checkpoint.
	if _, err := worker.RunOnce(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RunOnce(context.Background(), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// Then: the RuntimeLog values handed to Store.Insert and durable state have no canary.
	for _, record := range state.records {
		if strings.Contains(record.Line, "FORBIDDEN") {
			t.Fatalf("pre-insert RuntimeLog leaked: %q", record.Line)
		}
	}
	for _, checkpoint := range state.states {
		if strings.Contains(checkpoint, "FORBIDDEN") {
			t.Fatalf("checkpoint leaked: %q", checkpoint)
		}
	}
	if len(state.records) != 2 {
		t.Fatalf("restart did not persist both rows: %d", len(state.records))
	}
	t.Logf("pre_insert_runtime_logs=%q,%q checkpoint=%s", state.records[0].Line, state.records[1].Line, state.states["logs-state:uid:app"])
}

func TestIngestionMarksSourceUncertainWhenReadIsTruncated(t *testing.T) {
	// Given: Kubernetes returns complete rows followed by a discarded partial tail.
	now := time.Date(2026, 9, 13, 1, 2, 3, 4, time.UTC)
	source := &truncatedSource{fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: "ready"}}}}}
	state := &fakeStore{}
	// When: the complete prefix is accepted despite the truncated source window.
	_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	// Then: its durable checkpoint becomes permanently uncertain before another read.
	checkpoint := state.states["logs-state:uid:app"]
	if err != nil || state.records[0].Line != "****" || !strings.Contains(checkpoint, `"uncertain":true`) {
		t.Fatalf("truncation was not fail-closed: err=%v row=%#v state=%q", err, state.records, checkpoint)
	}
	t.Logf("source_limited=true pre_insert_line=%q checkpoint=%s", state.records[0].Line, checkpoint)
}

func TestIngestionMasksColdStartWithoutParserCheckpoint(t *testing.T) {
	// Given: the first retained source row may continue a quote that began before observation.
	now := time.Date(2026, 9, 13, 1, 2, 3, 4, time.UTC)
	source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: now, Line: `AuditSyntheticValue_97531" ready`}}}}
	state := &fakeStore{}
	// When: collection starts with neither source cursor nor parser checkpoint.
	_, err := New(Config{}, source, state).RunOnce(context.Background(), now)
	// Then: the first RuntimeLog handed to Store.Insert is fail-closed and state stays uncertain.
	checkpoint := state.states["logs-state:uid:app"]
	if err != nil || len(state.records) != 1 || state.records[0].Line != "****" || !strings.Contains(checkpoint, `"uncertain":true`) {
		t.Fatalf("cold start trusted absent context: err=%v records=%#v state=%q", err, state.records, checkpoint)
	}
	t.Logf("cold_start=true pre_insert_line=%q checkpoint=%s", state.records[0].Line, checkpoint)
}

func TestIngestionMasksWhenRetentionClampSkipsCheckpointPosition(t *testing.T) {
	// Given: parser state matches an old cursor, but retention moves the actual read start forward.
	now := time.Date(2026, 9, 13, 1, 2, 3, 4, time.UTC)
	oldCursor := now.Add(-8 * 24 * time.Hour)
	readStart := now.Add(-7 * 24 * time.Hour)
	source := &fakeSource{pods: []Pod{{UID: "uid", Name: "pod", Containers: []string{"app"}, Labels: map[string]string{serviceLabel: "svc-1", deploymentLabel: "dep-1"}}}, logs: map[string][]LogEntry{"app": {{Timestamp: readStart, Line: `AuditSyntheticValue_97531" ready`}}}}
	checkpoint := `{"v":1,"pem":false,"sequence":1,"watermark":"` + oldCursor.Format(time.RFC3339Nano) + `"}`
	state := &fakeStore{cursors: map[string]time.Time{"logs:uid:app": oldCursor}, states: map[string]string{"logs-state:uid:app": checkpoint}}
	// When: retention clamps ReadLogs beyond the validated checkpoint position.
	_, err := New(Config{Retention: 7 * 24 * time.Hour}, source, state).RunOnce(context.Background(), now)
	// Then: skipped parser context invalidates state before the first RuntimeLog is produced.
	checkpoint = state.states["logs-state:uid:app"]
	if err != nil || len(state.records) != 1 || state.records[0].Line != "****" || !strings.Contains(checkpoint, `"uncertain":true`) || !strings.Contains(checkpoint, readStart.Format(time.RFC3339Nano)) {
		t.Fatalf("retention gap trusted stale context: err=%v records=%#v state=%q", err, state.records, checkpoint)
	}
	t.Logf("retention_clamped=true pre_insert_line=%q checkpoint=%s", state.records[0].Line, checkpoint)
}
