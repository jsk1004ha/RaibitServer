package redact

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIngestionAdversarialSharedRedactionCorpus(t *testing.T) {
	// Given: the shared immutable cross-language corpus, not a lane-owned copy.
	root := os.Getenv("RAIBITSERVER_OBSERVABILITY_FIXTURES")
	if root == "" {
		root = "../../../../tests/fixtures"
	}
	raw, err := os.ReadFile(filepath.Join(root, "observability-redaction-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Cases   []struct{ Name, Input, Expected string }
		Streams []struct {
			Name    string
			Records []struct {
				Input, Expected string
				PEMAfter        bool
			}
		}
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, test := range corpus.Cases {
		t.Run(test.Name, func(t *testing.T) {
			// When / Then: exact harmless context and idempotence survive masking.
			got := Text(test.Input)
			if got != test.Expected || Text(got) != got || strings.Contains(got, "FORBIDDEN") {
				t.Fatal("shared redaction mismatch")
			}
		})
	}
	for _, stream := range corpus.Streams {
		t.Run(stream.Name, func(t *testing.T) {
			state := State{Version: 1}
			for _, record := range stream.Records {
				got, next := Line(record.Input, state)
				if got != record.Expected || next.PEM != record.PEMAfter {
					t.Fatal("stream continuation mismatch")
				}
				encoded, err := json.Marshal(next)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(encoded), "FORBIDDEN") {
					t.Fatal("secret state")
				}
				if err := json.Unmarshal(encoded, &state); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestIngestionAdversarialQuotedAndPartialMarkerContinuation(t *testing.T) {
	for _, records := range [][]string{{`password="FORBIDDEN_START`, `FORBIDDEN_END" ready`}, {`before -----BEGIN RSA PRI`, `VATE KEY----- FORBIDDEN_BODY`, `-----END RSA PRIVATE KEY----- ready`}} {
		// Given / When: an assignment or PEM marker spans producer records.
		state := State{Version: 1}
		for _, record := range records {
			line, next := Line(record, state)
			state = next
			// Then: neither the assignment continuation nor split marker emits source bytes.
			if strings.Contains(line, "FORBIDDEN") {
				t.Fatal("multiline secret leaked")
			}
		}
		if state.PEM || state.Quote != "" {
			t.Fatal("continuation failed to close")
		}
	}
}
