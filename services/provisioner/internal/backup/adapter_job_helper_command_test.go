package backup

import (
	"errors"
	"testing"
)

type helperCommandSequence struct {
	firstAction, secondAction   string
	firstBinding, secondBinding StreamBinding
}

func Test_NewIsolatedJob_when_reserved_helper_sequence_is_adapter_shaped(t *testing.T) {
	// Given: the two concrete helper sequences each engine adapter emits.
	tests := []struct {
		name     string
		engine   Engine
		sequence helperCommandSequence
	}{
		{name: "postgresql dump", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql")},
		{name: "postgresql restore", engine: EnginePostgreSQL, sequence: databaseRestoreSequence("postgresql")},
		{name: "mysql dump", engine: EngineMySQL, sequence: databaseDumpSequence("mysql")},
		{name: "mysql restore", engine: EngineMySQL, sequence: databaseRestoreSequence("mysql")},
		{name: "mariadb dump", engine: EngineMariaDB, sequence: databaseDumpSequence("mariadb")},
		{name: "mariadb restore", engine: EngineMariaDB, sequence: databaseRestoreSequence("mariadb")},
		{name: "mongodb dump", engine: EngineMongoDB, sequence: databaseDumpSequence("mongodb")},
		{name: "mongodb restore", engine: EngineMongoDB, sequence: databaseRestoreSequence("mongodb")},
		{name: "redis backup", engine: EngineRedis, sequence: cacheBackupSequence("redis")},
		{name: "redis restore", engine: EngineRedis, sequence: cacheRestoreSequence("redis")},
		{name: "valkey backup", engine: EngineValkey, sequence: cacheBackupSequence("valkey")},
		{name: "valkey restore", engine: EngineValkey, sequence: cacheRestoreSequence("valkey")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			connection := testHelperCommandConnection(t, test.engine)
			spec := helperJobSpec(t, connection, test.sequence)

			// When: the adapter-shaped helper pair reaches the isolated-job boundary.
			_, jobErr := NewIsolatedJob(spec)

			// Then: its fixed helper/action/binding sequence is admitted.
			if jobErr != nil {
				t.Fatalf("engine=%q sequence=%+v err=%v", test.engine, test.sequence, jobErr)
			}
		})
	}
}

func Test_NewIsolatedJob_when_reserved_helper_sequence_is_not_exact(t *testing.T) {
	// Given: two-step helper plans that vary one protected aspect while retaining one stream binding.
	tests := []struct {
		name       string
		engine     Engine
		sequence   helperCommandSequence
		executable string
		extra      string
	}{
		{name: "wrong engine", engine: EngineRedis, sequence: databaseDumpSequence("postgresql"), executable: recoveryDatabaseHelper},
		{name: "cross helper", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), executable: recoveryCacheHelper},
		{name: "reordered", engine: EnginePostgreSQL, sequence: helperCommandSequence{firstAction: "postgresql-dump", firstBinding: StreamStdout, secondAction: "postgresql-verify", secondBinding: StreamNone}},
		{name: "wrong binding", engine: EnginePostgreSQL, sequence: helperCommandSequence{firstAction: "postgresql-verify", firstBinding: StreamStdout, secondAction: "postgresql-dump", secondBinding: StreamNone}},
		{name: "duplicate action", engine: EnginePostgreSQL, sequence: helperCommandSequence{firstAction: "postgresql-verify", firstBinding: StreamNone, secondAction: "postgresql-verify", secondBinding: StreamStdout}},
		{name: "unknown helper", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), executable: "raibit-recovery-other"},
		{name: "extra argv", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), extra: "--verbose"},
		{name: "endpoint injection", engine: EnginePostgreSQL, sequence: databaseDumpSequence("postgresql"), extra: "source.db.internal"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			connection := testHelperCommandConnection(t, test.engine)
			spec := helperJobSpec(t, connection, test.sequence)
			if test.executable != "" {
				for index, stepSpec := range []struct {
					action  string
					binding StreamBinding
				}{{test.sequence.firstAction, test.sequence.firstBinding}, {test.sequence.secondAction, test.sequence.secondBinding}} {
					step, err := newHelperCommandStep(test.executable, stepSpec.action, stepSpec.binding)
					if err != nil {
						t.Fatal(err)
					}
					spec.Steps[index] = step
				}
			}
			if test.extra != "" {
				command, err := newDirectCommand(recoveryDatabaseHelper, test.sequence.secondAction, test.extra)
				if err != nil {
					t.Fatal(err)
				}
				step, err := newCommandStep(command, test.sequence.secondBinding)
				if err != nil {
					t.Fatal(err)
				}
				spec.Steps[1] = step
			}

			// When: a helper pair escapes its exact engine-owned protocol.
			_, jobErr := NewIsolatedJob(spec)

			// Then: the runner receives no mutable or cross-engine command sequence.
			if !errors.Is(jobErr, ErrRecoveryJob) {
				t.Fatalf("engine=%q sequence=%+v extra=%q err=%v", test.engine, test.sequence, test.extra, jobErr)
			}
		})
	}
}

func Test_NewIsolatedJob_when_reserved_helper_sequence_is_incomplete(t *testing.T) {
	// Given: only the verification half of a valid PostgreSQL dump protocol.
	connection := testHelperCommandConnection(t, EnginePostgreSQL)
	spec := helperJobSpec(t, connection, databaseDumpSequence("postgresql"))
	spec.Steps = spec.Steps[:1]

	// When: a one-step helper plan reaches the common stream invariant.
	_, jobErr := NewIsolatedJob(spec)

	// Then: helper commands cannot bypass exactly-one-stream enforcement.
	if !errors.Is(jobErr, ErrRecoveryJob) {
		t.Fatalf("incomplete helper sequence accepted: %v", jobErr)
	}
}

func Test_NewIsolatedJob_when_reserved_helper_sequence_has_extra_or_mixed_steps(t *testing.T) {
	// Given: a correct PostgreSQL dump pair with an extra helper or arbitrary command appended.
	connection := testHelperCommandConnection(t, EnginePostgreSQL)
	for _, extra := range []CommandStep{
		mustHelperCommandStep(t, recoveryDatabaseHelper, "postgresql-verify", StreamNone),
		mustHelperCommandStep(t, "recovery-tool", "--prepare", StreamNone),
	} {
		spec := helperJobSpec(t, connection, databaseDumpSequence("postgresql"))
		spec.Steps = append(spec.Steps, extra)

		// When: a third step is appended to the capability-limited helper pair.
		_, jobErr := NewIsolatedJob(spec)

		// Then: extra and mixed command pipelines are denied.
		if !errors.Is(jobErr, ErrRecoveryJob) {
			t.Fatalf("extra=%+v err=%v", extra, jobErr)
		}
	}
}

func Test_NewIsolatedJob_when_endpoint_words_overlap_helper_tokens(t *testing.T) {
	// Given: server-owned endpoint values that happen to equal substrings in helper names.
	connection := testNetworkConnection(t, "source", "db.internal", "source-secret", "DATABASE_URL", "16.4")
	connectionSpec := connection.Spec()
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: "db.internal", Port: 5432, Database: "db", User: "recovery"})
	if err != nil {
		t.Fatal(err)
	}
	connectionSpec.Endpoint = endpoint
	boundConnection, err := newConnection(connectionSpec, connection.toolImage, connection.operationID, connection.attempt)
	if err != nil {
		t.Fatal(err)
	}
	spec := helperJobSpec(t, boundConnection, databaseDumpSequence("postgresql"))

	// When: the complete helper sequence has no endpoint-derived argv token.
	_, jobErr := NewIsolatedJob(spec)

	// Then: lexical overlap cannot turn its fixed helper actions into an endpoint leak.
	if jobErr != nil {
		t.Fatalf("helper rejected for overlapping endpoint words: %v", jobErr)
	}
}

func Test_NewIsolatedJob_when_legacy_command_copies_endpoint_argv(t *testing.T) {
	// Given: a non-helper native command with a server-owned host embedded in a flag.
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	spec := testJobSpec(t, connection, StreamStdout)
	command, err := newDirectCommand("pg_dump", "--host=source.db.internal")
	if err != nil {
		t.Fatal(err)
	}
	spec.Steps[0], err = newCommandStep(command, StreamStdout)
	if err != nil {
		t.Fatal(err)
	}

	// When: the legacy native CLI plan reaches the isolated-job boundary.
	_, jobErr := NewIsolatedJob(spec)

	// Then: the helper exception does not weaken raw endpoint-leak rejection.
	if !errors.Is(jobErr, ErrRecoveryJob) {
		t.Fatalf("legacy endpoint argv accepted: %v", jobErr)
	}
}

func testHelperCommandConnection(t *testing.T, engine Engine) Connection {
	t.Helper()
	connection := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	connectionSpec := connection.Spec()
	connectionSpec.Engine.Engine = engine
	switch engine {
	case EngineRedis, EngineValkey:
		index := uint16(0)
		endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: "cache.internal", Port: 6379, User: "provider", Index: &index})
		if err != nil {
			t.Fatal(err)
		}
		connectionSpec.Endpoint = endpoint
	}
	boundConnection, err := newConnection(connectionSpec, connection.toolImage, connection.operationID, connection.attempt)
	if err != nil {
		t.Fatal(err)
	}
	return boundConnection
}

func helperJobSpec(t *testing.T, connection Connection, sequence helperCommandSequence) IsolatedJobSpec {
	t.Helper()
	first, err := newHelperCommandStep(recoveryHelperForEngine(connection.Engine()), sequence.firstAction, sequence.firstBinding)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newHelperCommandStep(recoveryHelperForEngine(connection.Engine()), sequence.secondAction, sequence.secondBinding)
	if err != nil {
		t.Fatal(err)
	}
	spec := testJobSpec(t, connection, StreamStdout)
	spec.Steps = []CommandStep{first, second}
	return spec
}

func recoveryHelperForEngine(engine Engine) string {
	switch engine {
	case EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB:
		return recoveryDatabaseHelper
	case EngineRedis, EngineValkey:
		return recoveryCacheHelper
	default:
		return ""
	}
}

func mustHelperCommandStep(t *testing.T, executable, action string, binding StreamBinding) CommandStep {
	t.Helper()
	step, err := newHelperCommandStep(executable, action, binding)
	if err != nil {
		t.Fatal(err)
	}
	return step
}

func newHelperCommandStep(executable, action string, binding StreamBinding) (CommandStep, error) {
	command, err := newDirectCommand(executable, action)
	if err != nil {
		return CommandStep{}, err
	}
	return newCommandStep(command, binding)
}

func databaseDumpSequence(engine string) helperCommandSequence {
	return helperCommandSequence{firstAction: engine + "-verify", firstBinding: StreamNone, secondAction: engine + "-dump", secondBinding: StreamStdout}
}

func databaseRestoreSequence(engine string) helperCommandSequence {
	return helperCommandSequence{firstAction: engine + "-restore", firstBinding: StreamStdin, secondAction: engine + "-verify", secondBinding: StreamNone}
}

func cacheBackupSequence(engine string) helperCommandSequence {
	return helperCommandSequence{firstAction: engine + "-verify", firstBinding: StreamNone, secondAction: engine + "-backup", secondBinding: StreamStdout}
}

func cacheRestoreSequence(engine string) helperCommandSequence {
	return helperCommandSequence{firstAction: engine + "-restore", firstBinding: StreamStdin, secondAction: engine + "-verify", secondBinding: StreamNone}
}
