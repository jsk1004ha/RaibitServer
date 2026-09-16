package recoverydb

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func Test_Run_mongodb_actions_use_config_and_stream_archive(t *testing.T) {
	for _, test := range []struct {
		action     string
		executable string
		wantArg    string
	}{
		{action: "mongodb-dump", executable: "mongodump", wantArg: "--archive"},
		{action: "mongodb-restore", executable: "mongorestore", wantArg: "--archive"},
		{action: "mongodb-verify", executable: "mongosh", wantArg: "--nodb"},
	} {
		t.Run(test.action, func(t *testing.T) {
			// Given
			executor := successfulExecutor()
			deps, scratch := testDependencies(t, executor, validEnvironment(), "p@ss:/ word")
			input := []byte("archive")
			if test.action == "mongodb-restore" {
				input = testEnvelope(t, "mongodb-dump", "archive")
			}
			var stdout bytes.Buffer

			// When
			err := run(context.Background(), invocation{action: test.action, streams: Streams{Stdin: bytes.NewReader(input), Stdout: &stdout, Stderr: io.Discard}}, deps)

			// Then
			if err != nil {
				t.Fatalf("run %s: %v", test.action, err)
			}
			recordIndex := 0
			if test.action == "mongodb-dump" || test.action == "mongodb-restore" {
				recordIndex = 1
			}
			if test.action == "mongodb-dump" {
				payload, _ := decodeEnvelope(t, stdout.Bytes())
				if payload != "archive" || strings.Contains(stdout.String(), "\narchive") {
					t.Fatalf("dump was not exclusively framed: %q", stdout.String())
				}
			}
			record := executor.records[recordIndex]
			if record.spec.executable != test.executable || !contains(record.spec.args, test.wantArg) {
				t.Fatalf("unexpected process: %#v", record.spec)
			}
			if test.action != "mongodb-verify" && !contains(record.spec.args, "--gzip") {
				t.Fatalf("MongoDB archive is not gzip encoded: %#v", record.spec.args)
			}
			config := string(record.config["mongodb.json"])
			if !strings.Contains(config, `"uri":"mongodb://operator@database.internal:5432/app"`) || !strings.Contains(config, `"password":"p@ss:/ word"`) {
				t.Fatalf("unexpected MongoDB config: %q", config)
			}
			if test.action == "mongodb-verify" {
				script := string(record.config["baseline.js"])
				for _, forbidden := range []string{"insertOne", "deleteOne", ".drop()", "restore_sentinel"} {
					if strings.Contains(script, forbidden) {
						t.Fatalf("source verification mutates data with %q: %q", forbidden, script)
					}
				}
				coordinator := deps.receipts.(*fakeReceiptCoordinator)
				if coordinator.stage == nil || coordinator.stage.Direction() != recoveryreceipt.DirectionDump {
					t.Fatal("source preflight did not write dump stage")
				}
			}
			assertPrivateConfigs(t, record)
			assertScratchClean(t, scratch)
		})
	}
}
