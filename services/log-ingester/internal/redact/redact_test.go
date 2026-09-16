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
				Input, Expected          string
				PEMAfter, UncertainAfter bool
				QuoteAfter               string
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
				t.Fatalf("shared redaction mismatch: got=%q want=%q", got, test.Expected)
			}
		})
	}
	for _, stream := range corpus.Streams {
		t.Run(stream.Name, func(t *testing.T) {
			state := State{Version: 1}
			for _, record := range stream.Records {
				got, next := Line(record.Input, state)
				if got != record.Expected || next.PEM != record.PEMAfter || next.Quote != record.QuoteAfter || next.Uncertain != record.UncertainAfter {
					t.Fatalf("stream continuation mismatch: got=%q want=%q state=%#v quoteAfter=%q", got, record.Expected, next, record.QuoteAfter)
				}
				encoded, err := json.Marshal(next)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(encoded), "FORBIDDEN") {
					t.Fatal("secret state")
				}
				state = State{}
				if err := json.Unmarshal(encoded, &state); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	t.Logf("shared_corpus_cases=%d streams=%d no_canary=true", len(corpus.Cases), len(corpus.Streams))
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

func TestRedactionMasksSensitiveEnvironmentSuffixes(t *testing.T) {
	fragments := []string{
		"password", "passwd", "secret", "token", "credential", "apikey", "api_key", "api-key",
		"accesskey", "access_key", "access-key", "privatekey", "private_key", "private-key",
		"databaseurl", "database_url", "database-url", "mongodburi", "mongodb_uri", "mongodb-uri",
		"redisurl", "redis_url", "redis-url",
	}
	for _, fragment := range fragments {
		for _, prefix := range []string{"", "-", "--", "POSTGRES_"} {
			// Given: every common-corpus fragment is an exact key or environment suffix.
			input := prefix + strings.ToUpper(fragment) + "_1=FORBIDDEN_" + strings.ToUpper(fragment)
			// When: the Go pre-storage redactor processes the assignment.
			got := Text(input)
			// Then: the key remains useful and no source secret bytes survive.
			if strings.Contains(got, "FORBIDDEN") || !strings.HasSuffix(got, "=****") {
				t.Fatalf("sensitive key survived: key=%q output=%q", prefix+fragment, got)
			}
		}
	}
}

func TestRedactionPreservesNonSensitiveKeyWords(t *testing.T) {
	// Given: key-like words that are not exact sensitive fragments or suffixes.
	input := "keyboard=us monkey=banana KEY_VERSION=2"
	// When / Then: harmless values remain byte-for-byte intact.
	if got := Text(input); got != input {
		t.Fatalf("false positive: %q", got)
	}
}

func TestRedactionMasksQuotedEnvironmentContinuationAcrossRestart(t *testing.T) {
	// Given: a quoted environment-suffixed secret spans source records.
	state := State{Version: 1}
	first, state := Line(`POSTGRES_PASSWORD="FORBIDDEN_START`, state)
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var restarted State
	if err := json.Unmarshal(raw, &restarted); err != nil {
		t.Fatal(err)
	}
	// When: a restarted parser consumes the closing source record.
	second, state := Line(`FORBIDDEN_END" ready`, restarted)
	// Then: neither record nor serialized continuation contains the canary.
	if strings.Contains(first+second+string(raw), "FORBIDDEN") || state.Quote != "" || first != `POSTGRES_PASSWORD="****"` || second != `****" ready` {
		t.Fatalf("quoted restart leaked: first=%q second=%q state=%s", first, second, raw)
	}
}

func TestRedactionUncertainStateCannotBeClearedByPEMEnd(t *testing.T) {
	// Given: source truncation made parser context unknowable.
	state := State{Version: 1, PEM: true, Quote: `"`, Uncertain: true}
	// When: unrelated closing markers and harmless text arrive.
	got, next := Line(`-----END PRIVATE KEY----- ready"`, state)
	// Then: the source remains permanently fail-closed.
	if got != "****" || !next.Uncertain || next.PEM != state.PEM || next.Quote != state.Quote {
		t.Fatalf("uncertain state cleared: output=%q state=%#v", got, next)
	}
}

func TestRedactionHandlesMaximumSourceWindowWithoutBacktracking(t *testing.T) {
	// Given: the maximum configured source window ends in a sensitive environment assignment.
	input := strings.Repeat("x", 1024*1024-len(" POSTGRES_PASSWORD=FORBIDDEN_MAX")) + " POSTGRES_PASSWORD=FORBIDDEN_MAX"
	// When: the complete bounded source value crosses the Go redaction boundary.
	got := Text(input)
	// Then: the scan completes and masks the terminal value without changing the bound.
	if len(got) >= len(input) || strings.Contains(got, "FORBIDDEN") || !strings.HasSuffix(got, " POSTGRES_PASSWORD=****") {
		t.Fatalf("bounded source window mismatch: input=%d output=%d", len(input), len(got))
	}
}

func TestRedactionDoesNotCloseEscapedDelimiterInsideSerializedContinuation(t *testing.T) {
	// Given: a restarted escaped quote contains an inner quote preceded by three backslashes.
	input := `prefix` + strings.Repeat(`\`, 3) + `"AuditSyntheticValue_97531\" ready`
	// When: continuation state searches for its actual closing delimiter.
	got, next := Line(input, State{Version: 1, Quote: `\"`})
	// Then: the inner escaped quote cannot end masking before the canary.
	if got != `****\" ready` || strings.Contains(got, "AuditSyntheticValue_97531") || next.Quote != "" {
		t.Fatalf("escaped delimiter ended early: %q", got)
	}
}

func TestRedactionPreservesOrdinaryAssignmentNeighbors(t *testing.T) {
	// Given: ordinary assignments use punctuation as a value boundary, unlike URL query values.
	input := "PASSWORD=value,ready=true SECRET=value;healthy=true"
	// When / Then: only each secret value is replaced and benign neighbors remain.
	if got := Text(input); got != "PASSWORD=****,ready=true SECRET=****;healthy=true" {
		t.Fatalf("ordinary assignment neighbor consumed: %q", got)
	}
}
