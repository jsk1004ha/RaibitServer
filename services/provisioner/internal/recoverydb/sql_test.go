package recoverydb

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func Test_Run_postgresql_dump_uses_service_and_pass_files(t *testing.T) {
	// Given
	executor := successfulExecutor()
	deps, scratch := testDependencies(t, executor, validEnvironment(), "s3:cr\\et")
	var stdout bytes.Buffer

	// When
	err := run(context.Background(), invocation{action: "postgresql-dump", streams: Streams{Stdout: &stdout, Stderr: io.Discard}}, deps)

	// Then
	if err != nil {
		t.Fatalf("run postgresql dump: %v", err)
	}
	if len(executor.records) != 3 {
		t.Fatalf("unexpected execution: stdout=%q records=%d", stdout.String(), len(executor.records))
	}
	payload, decoded := decodeEnvelope(t, stdout.Bytes())
	if payload != "archive" || string(decoded.Metadata.Engine()) != "postgresql" {
		t.Fatalf("unexpected envelope: payload=%q engine=%q", payload, decoded.Metadata.Engine())
	}
	record := executor.records[1]
	if record.spec.executable != "pg_dump" || strings.Join(record.spec.args, " ") != "--format=custom --no-owner --no-privileges" {
		t.Fatalf("unexpected process: %#v", record.spec)
	}
	assertEnvironment(t, record.spec.env, map[string]string{
		"PGSERVICE": "raibit-recovery", "PGSERVICEFILE": record.spec.configPaths[0], "PGPASSFILE": record.spec.configPaths[1], "LC_ALL": "C",
	})
	assertPrivateConfigs(t, record)
	if got := string(record.config["pg_service.conf"]); !strings.Contains(got, "host=database.internal\n") || strings.Contains(got, "s3:cr") {
		t.Fatalf("unsafe service config: %q", got)
	}
	if got := string(record.config["pgpass"]); got != "database.internal:5432:app:operator:s3\\:cr\\\\et\n" {
		t.Fatalf("unexpected pgpass: %q", got)
	}
	assertScratchClean(t, scratch)
}

func Test_Run_mysql_restore_places_private_defaults_file_first(t *testing.T) {
	// Given
	executor := successfulExecutor()
	deps, scratch := testDependencies(t, executor, validEnvironment(), `p#;"word`)
	envelope := testEnvelope(t, "mysql-dump", "dump")

	// When
	err := run(context.Background(), invocation{action: "mysql-restore", streams: Streams{Stdin: bytes.NewReader(envelope), Stdout: io.Discard, Stderr: io.Discard}}, deps)

	// Then
	if err != nil {
		t.Fatalf("run mysql restore: %v", err)
	}
	if len(executor.records) != 2 {
		t.Fatalf("executions=%d", len(executor.records))
	}
	record := executor.records[1]
	if record.spec.executable != "mysql" || len(record.spec.args) != 2 || !strings.HasPrefix(record.spec.args[0], "--defaults-extra-file=") || record.spec.args[1] != "--binary-mode=1" {
		t.Fatalf("defaults file was not the first option: %#v", record.spec)
	}
	if record.stdin != "dump" {
		t.Fatalf("restore stdin=%q", record.stdin)
	}
	config := string(record.config["mysql.cnf"])
	for _, wanted := range []string{"host=database.internal", "port=5432", "database=app", `password="p#;\"word"`} {
		if !strings.Contains(config, wanted) {
			t.Fatalf("mysql config missing %q: %q", wanted, config)
		}
	}
	assertPrivateConfigs(t, record)
	assertScratchClean(t, scratch)
}

func Test_Plans_allow_only_fixed_native_executables(t *testing.T) {
	wanted := map[string]string{
		"postgresql-verify": "psql", "postgresql-dump": "pg_dump", "postgresql-restore": "pg_restore",
		"mysql-verify": "mysql", "mysql-dump": "mysqldump", "mysql-restore": "mysql",
		"mariadb-verify": "mariadb", "mariadb-dump": "mariadb-dump", "mariadb-restore": "mariadb",
	}
	for actionName, executable := range wanted {
		t.Run(actionName, func(t *testing.T) {
			// Given
			deps, scratch := testDependencies(t, successfulExecutor(), validEnvironment(), "secret")
			work, err := newWorkspace(scratch)
			if err != nil {
				t.Fatalf("new workspace: %v", err)
			}
			defer func() {
				if err := work.close(); err != nil {
					t.Errorf("close workspace: %v", err)
				}
			}()
			target, err := parseEndpoint(deps.lookupEnv, []byte("secret"))
			if err != nil {
				t.Fatalf("parse endpoint: %v", err)
			}
			selected, err := parseAction(actionName)
			if err != nil {
				t.Fatalf("parse action: %v", err)
			}

			// When
			spec, err := buildPlan(selected, target, work)

			// Then
			if err != nil || spec.executable != executable {
				t.Fatalf("err=%v process=%#v", err, spec)
			}
			if strings.HasPrefix(actionName, "mysql-") || strings.HasPrefix(actionName, "mariadb-") {
				if !strings.HasPrefix(spec.args[0], "--defaults-extra-file=") {
					t.Fatalf("defaults file not first: %#v", spec.args)
				}
			}
		})
	}
}

func Test_Source_verification_is_read_only_and_writes_preflight_stage(t *testing.T) {
	for _, actionName := range []string{"postgresql-verify", "mysql-verify", "mariadb-verify"} {
		t.Run(actionName, func(t *testing.T) {
			// Given
			executor := successfulExecutor()
			deps, _ := testDependencies(t, executor, validEnvironment(), "secret")

			// When
			err := run(context.Background(), invocation{action: actionName, streams: Streams{Stdout: io.Discard, Stderr: io.Discard}}, deps)

			// Then
			if err != nil {
				t.Fatalf("run verification: %v", err)
			}
			if len(executor.records) != 1 {
				t.Fatalf("source preflight executions=%d", len(executor.records))
			}
			args := strings.Join(executor.records[0].spec.args, " ")
			for _, forbidden := range []string{"CREATE", "INSERT", "DROP", "restore_sentinel"} {
				if strings.Contains(args, forbidden) {
					t.Fatalf("source verification mutates data with %q: %q", forbidden, args)
				}
			}
			coordinator := deps.receipts.(*fakeReceiptCoordinator)
			if coordinator.stage == nil || coordinator.stage.Direction() != recoveryreceipt.DirectionDump || len(coordinator.receipts) != 0 {
				t.Fatalf("source preflight stage=%v receipts=%d", coordinator.stage != nil, len(coordinator.receipts))
			}
		})
	}
}
