package ingester

import (
	"context"
	"errors"
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
