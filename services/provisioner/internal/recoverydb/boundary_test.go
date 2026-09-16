package recoverydb

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_Run_rejects_untrusted_boundary_values_before_execution(t *testing.T) {
	tests := []struct {
		name       string
		action     string
		key        string
		value      string
		credential string
	}{
		{name: "unknown action", action: "postgresql-shell", credential: "secret"},
		{name: "host option injection", action: "postgresql-dump", key: envHost, value: "--host=evil", credential: "secret"},
		{name: "host newline", action: "mysql-dump", key: envHost, value: "db\npassword=evil", credential: "secret"},
		{name: "empty DNS label", action: "mysql-dump", key: envHost, value: "db..internal", credential: "secret"},
		{name: "invalid port", action: "mariadb-dump", key: envPort, value: "65536", credential: "secret"},
		{name: "database option injection", action: "mongodb-dump", key: envDatabase, value: "app/../admin", credential: "secret"},
		{name: "username option injection", action: "postgresql-dump", key: envUsername, value: "owner --command=evil", credential: "secret"},
		{name: "credential newline", action: "mysql-dump", credential: "secret\noption=evil"},
		{name: "credential invalid UTF-8", action: "mysql-dump", credential: string([]byte{0xff, 0xfe})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			environment := validEnvironment()
			if test.key != "" {
				environment[test.key] = test.value
			}
			executor := &fakeExecutor{}
			deps, scratch := testDependencies(t, executor, environment, test.credential)

			// When
			err := run(context.Background(), invocation{action: test.action, streams: Streams{Stdout: io.Discard, Stderr: io.Discard}}, deps)

			// Then
			if !errors.Is(err, ErrInvalidInput) || len(executor.records) != 0 {
				t.Fatalf("err=%v executions=%d", err, len(executor.records))
			}
			assertScratchClean(t, scratch)
		})
	}
}

func Test_Run_redacts_process_error_and_bounded_stderr(t *testing.T) {
	// Given
	secret := "hidden-password"
	host := "database.internal"
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		if record.spec.executable == "psql" {
			_, err := io.WriteString(streams.Stdout, baselineOutput("160004", "descriptor"))
			return err
		}
		_, _ = io.WriteString(streams.Stderr, host+" "+secret+strings.Repeat("x", maxStderrBytes))
		return errors.New("native failure " + host + " " + secret)
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), secret)
	var stderr bytes.Buffer

	// When
	err := run(context.Background(), invocation{action: "postgresql-dump", streams: Streams{Stdout: io.Discard, Stderr: &stderr}}, deps)

	// Then
	if !errors.Is(err, ErrProcessFailed) {
		t.Fatalf("err=%v", err)
	}
	combined := err.Error() + stderr.String()
	if strings.Contains(combined, secret) || strings.Contains(combined, host) || stderr.Len() > maxStderrBytes {
		t.Fatalf("unredacted or unbounded output: len=%d value=%q", stderr.Len(), combined)
	}
}

func Test_Run_redacts_percent_encoded_mongodb_credential(t *testing.T) {
	// Given
	secret := "p@ss:/ word"
	encoded := "p%40ss%3A%2F%20word"
	executor := &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		if record.spec.executable == "mongosh" {
			_, err := io.WriteString(streams.Stdout, baselineOutput("8.4.1", "descriptor"))
			return err
		}
		_, _ = io.WriteString(streams.Stderr, "mongodb://operator:"+encoded+"@database.internal/app")
		return errors.New("mongo failed with " + encoded)
	}}
	deps, _ := testDependencies(t, executor, validEnvironment(), secret)
	var stderr bytes.Buffer

	// When
	err := run(context.Background(), invocation{action: "mongodb-dump", streams: Streams{Stdout: io.Discard, Stderr: &stderr}}, deps)

	// Then
	if !errors.Is(err, ErrProcessFailed) || strings.Contains(stderr.String(), secret) || strings.Contains(stderr.String(), encoded) {
		t.Fatalf("err=%v stderr=%q", err, stderr.String())
	}
}

func Test_Run_cancellation_stops_process_and_cleans_config(t *testing.T) {
	// Given
	ctx, cancel := context.WithCancel(context.Background())
	executor := &fakeExecutor{hook: func(ctx context.Context, _ recordedProcess, _ Streams) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}}
	deps, scratch := testDependencies(t, executor, validEnvironment(), "secret")

	// When
	err := run(ctx, invocation{action: "mariadb-verify", streams: Streams{Stdout: io.Discard, Stderr: io.Discard}}, deps)

	// Then
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	assertScratchClean(t, scratch)
}
