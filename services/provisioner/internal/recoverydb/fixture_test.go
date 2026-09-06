package recoverydb

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type recordedProcess struct {
	spec       processSpec
	stdin      string
	config     map[string][]byte
	configMode map[string]os.FileMode
}

type processHook func(context.Context, recordedProcess, Streams) error

type fakeExecutor struct {
	records []recordedProcess
	hook    processHook
}

func (f *fakeExecutor) Execute(ctx context.Context, spec processSpec, streams Streams) error {
	record := recordedProcess{spec: spec, config: map[string][]byte{}, configMode: map[string]os.FileMode{}}
	if streams.Stdin != nil {
		payload, err := io.ReadAll(streams.Stdin)
		if err != nil {
			return err
		}
		record.stdin = string(payload)
	}
	for _, path := range spec.configPaths {
		payload, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		record.config[filepath.Base(path)] = payload
		record.configMode[filepath.Base(path)] = info.Mode().Perm()
	}
	f.records = append(f.records, record)
	if f.hook != nil {
		return f.hook(ctx, record, streams)
	}
	return nil
}

func successfulExecutor() *fakeExecutor {
	return &fakeExecutor{hook: func(_ context.Context, record recordedProcess, streams Streams) error {
		args := strings.Join(record.spec.args, " ")
		if strings.Contains(args, "server_version_num") || strings.Contains(args, "REGEXP_SUBSTR") || hasConfig(record.spec, "baseline.js") {
			_, err := io.WriteString(streams.Stdout, baselineOutput(versionForExecutable(record.spec.executable), "descriptor"))
			return err
		}
		switch record.spec.executable {
		case "pg_dump", "mysqldump", "mariadb-dump", "mongodump":
			_, err := io.WriteString(streams.Stdout, "archive")
			return err
		case "psql", "mysql", "mariadb", "mongosh":
			if strings.Contains(args, "recovery_verify") || hasConfig(record.spec, "verify.js") {
				_, err := io.WriteString(streams.Stdout, "raibitserver-recovery-v1\n")
				return err
			}
		}
		return nil
	}}
}

func hasConfig(spec processSpec, name string) bool {
	for _, path := range spec.configPaths {
		if filepath.Base(path) == name {
			return true
		}
	}
	return false
}

func versionForExecutable(executable string) string {
	if executable == "psql" {
		return "160004"
	}
	return "8.4.1"
}

func testDependencies(t *testing.T, executor processExecutor, environment map[string]string, credential string) (dependencies, string) {
	t.Helper()
	root := t.TempDir()
	testCredentialPath := filepath.Join(root, "credential")
	if err := os.WriteFile(testCredentialPath, []byte(credential), 0o600); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	testScratchDir := filepath.Join(root, "scratch")
	if err := os.Mkdir(testScratchDir, 0o700); err != nil {
		t.Fatalf("mkdir scratch: %v", err)
	}
	return dependencies{
		lookupEnv: func(key string) (string, bool) {
			value, ok := environment[key]
			return value, ok
		},
		credentialPath: testCredentialPath,
		scratchDir:     testScratchDir,
		executor:       executor,
		receipts:       &fakeReceiptCoordinator{},
	}, testScratchDir
}

func validEnvironment() map[string]string {
	return map[string]string{envHost: "database.internal", envPort: "5432", envDatabase: "app", envUsername: "operator"}
}

func assertEnvironment(t *testing.T, got []string, want map[string]string) {
	t.Helper()
	actual := map[string]string{}
	for _, item := range got {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			actual[key] = value
		}
	}
	for key, value := range want {
		if actual[key] != value {
			t.Fatalf("environment %s=%q, want %q (all=%#v)", key, actual[key], value, actual)
		}
	}
}

func assertPrivateConfigs(t *testing.T, record recordedProcess) {
	t.Helper()
	if privateFileMode != 0o600 {
		t.Fatalf("private file mode=%#o", privateFileMode)
	}
	if runtime.GOOS == "windows" {
		return
	}
	for name, mode := range record.configMode {
		if mode != 0o600 {
			t.Fatalf("config %s mode=%#o", name, mode)
		}
	}
}

func assertScratchClean(t *testing.T, scratch string) {
	t.Helper()
	entries, err := os.ReadDir(scratch)
	if err != nil {
		t.Fatalf("read scratch: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("scratch contains %d entries", len(entries))
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
