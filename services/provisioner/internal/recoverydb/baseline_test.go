package recoverydb

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_ParseBaseline_canonicalizes_descriptor_order(t *testing.T) {
	// Given
	first := baselineOutput("16.4", "schema-b", "schema-a")
	second := baselineOutput("16.4", "schema-a", "schema-b")

	// When
	left, leftErr := parseBaseline([]byte(first))
	right, rightErr := parseBaseline([]byte(second))

	// Then
	if leftErr != nil || rightErr != nil || left != right {
		t.Fatalf("left=%#v err=%v right=%#v err=%v", left, leftErr, right, rightErr)
	}
	if left.version != "16.4" || left.descriptorCount != 2 || left.schemaSHA256 == ([32]byte{}) || left.dataSHA256 == ([32]byte{}) || left.dataSHA256 == left.schemaSHA256 {
		t.Fatalf("unexpected baseline: %#v", left)
	}
}

func Test_ParseBaseline_rejects_unbounded_or_unstructured_output(t *testing.T) {
	tests := []struct {
		name   string
		output []byte
	}{
		{name: "raw tenant data", output: []byte("V\t16.4\ntenant_table\n")},
		{name: "invalid version", output: []byte("V\t16.4;evil\n")},
		{name: "duplicate version", output: []byte("V\t16.4\nV\t16.5\n")},
		{name: "invalid descriptor", output: []byte("V\t16.4\nD\t%%%\n")},
		{name: "oversized descriptor", output: []byte("V\t16.4\nD\t" + strings.Repeat("A", maxDescriptorBytes+1) + "\n")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, err := parseBaseline(test.output)

			// Then
			if !errors.Is(err, ErrBaseline) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func Test_BoundedProbeCapture_rejects_output_over_limit(t *testing.T) {
	// Given
	var capture boundedProbeCapture

	// When
	_, err := capture.Write(bytes.Repeat([]byte{'x'}, maxProbeBytes+1))

	// Then
	if !errors.Is(err, ErrBaseline) {
		t.Fatalf("err=%v", err)
	}
}

func Test_CollectBaseline_runs_read_only_machine_probe(t *testing.T) {
	for _, test := range []struct {
		name       string
		engine     engine
		executable string
	}{
		{name: "postgresql", engine: enginePostgreSQL, executable: "psql"},
		{name: "mysql", engine: engineMySQL, executable: "mysql"},
		{name: "mariadb", engine: engineMariaDB, executable: "mariadb"},
		{name: "mongodb", engine: engineMongoDB, executable: "mongosh"},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Given
			executor := &fakeExecutor{hook: func(_ context.Context, _ recordedProcess, streams Streams) error {
				_, err := io.WriteString(streams.Stdout, baselineOutput("16.4", "descriptor"))
				return err
			}}
			deps, scratch := testDependencies(t, executor, validEnvironment(), "secret")
			work, err := newWorkspace(scratch)
			if err != nil {
				t.Fatalf("new workspace: %v", err)
			}
			t.Cleanup(func() {
				if err := work.close(); err != nil {
					t.Errorf("close workspace: %v", err)
				}
			})
			target, err := parseEndpoint(deps.lookupEnv, []byte("secret"))
			if err != nil {
				t.Fatalf("parse endpoint: %v", err)
			}

			// When
			baseline, err := collectBaseline(context.Background(), baselineRequest{engine: test.engine, endpoint: target, work: work}, executor)

			// Then
			if err != nil || baseline.version != "16.4" || executor.records[0].spec.executable != test.executable {
				t.Fatalf("baseline=%#v err=%v records=%#v", baseline, err, executor.records)
			}
			args := strings.Join(executor.records[0].spec.args, " ")
			if strings.Contains(args, "raibitserver_recovery_verify") || !strings.Contains(args, "--") {
				t.Fatalf("probe is not read-only machine mode: %q", args)
			}
		})
	}
}

func baselineOutput(version string, descriptors ...string) string {
	var output strings.Builder
	output.WriteString("V\t" + version + "\n")
	for _, descriptor := range descriptors {
		output.WriteString("D\t" + base64.StdEncoding.EncodeToString([]byte(descriptor)) + "\n")
	}
	return output.String()
}
