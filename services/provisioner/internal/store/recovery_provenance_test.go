package store

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRecoverySourceGenerationMatchesFrozenTypeScript(t *testing.T) {
	// Given the cross-language fixture evaluated by the frozen TypeScript producer.
	r := &Resource{
		ID: "source", ProjectID: "project", Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection",
		DesiredSpec: map[string]any{"databaseName": "name<>&", "storageGb": 1}, DesiredState: decodeMap([]byte(recoveryState())),
	}
	// When Go recomputes the incarnation before a side effect.
	got, err := recoverySourceGeneration(r)
	// Then bytes match the independently executed producer, not a Go-derived expectation.
	const expected = "resource-incarnation/v1:sha256:b2313a70a0549dafdc7d8b8fb309f60b0d4658865cc89e24e1bc32ad85854571"
	if err != nil || got != expected {
		t.Fatalf("canonical hash=%s err=%v", got, err)
	}
}

func TestRecoverySourceGenerationIgnoresOnlyObservationTime(t *testing.T) {
	// Given identical immutable provenance with a later successful health observation.
	r := &Resource{ID: "source", ProjectID: "project", Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	before, err := recoverySourceGeneration(r)
	if err != nil {
		t.Fatal(err)
	}
	r.DesiredState = decodeMap([]byte(strings.Replace(recoveryState(), "2026-09-03", "2026-09-04", 1)))
	// When observation time changes without resource replacement.
	after, err := recoverySourceGeneration(r)
	// Then the incarnation remains stable.
	if err != nil || before != after {
		t.Fatal("health timestamp changed source incarnation")
	}
}

func TestRecoverySourceGenerationDistinguishesNullAndEmptyVersion(t *testing.T) {
	// Given nullable and explicitly empty version values, which the producer hashes differently.
	r := &Resource{ID: "source", ProjectID: "project", Type: "database", Engine: "postgresql", Provider: "raibitserver", Plan: "shared-small", Region: "local", ConnectionSecretName: "db-connection", DesiredState: decodeMap([]byte(recoveryState()))}
	absent, err := recoverySourceGeneration(r)
	if err != nil {
		t.Fatal(err)
	}
	r.VersionPresent = true
	// When the SQL NULL distinction is preserved.
	empty, err := recoverySourceGeneration(r)
	// Then nullable provenance cannot alias an explicit empty version.
	if err != nil || absent == empty {
		t.Fatal("SQL nullable version aliased empty string")
	}
}

func TestRecoverySourceGenerationRejectsAbsentOrForgedImage(t *testing.T) {
	for _, image := range []string{"{}", strings.Replace(recoveryState(), strings.Repeat("1", 64), strings.Repeat("0", 64), 1), strings.Replace(recoveryState(), `"workloadGeneration":1`, `"workloadGeneration":0`, 1)} {
		// Given missing or invalid applied-image evidence.
		r := &Resource{DesiredState: decodeMap([]byte(image))}
		// When a recovery fence needs the incarnation.
		_, err := recoverySourceGeneration(r)
		// Then configuration/zero evidence cannot substitute for observed image provenance.
		if err == nil {
			t.Fatal("unproven source accepted")
		}
	}
}

func TestRecoveryStorageErrorNeverContainsBackendDetail(t *testing.T) {
	// Given a PostgreSQL error carrying private object identity and credentials in its body.
	raw := &pgconn.PgError{Code: "42804", Message: "secret=credential", Detail: "organizations/private/artifact"}
	// When the store reports the failure.
	err := recoveryDBFailure(raw)
	// Then only the stable SQLSTATE is exposed.
	if err.Error() != "RECOVERY_STORAGE_FAILURE:42804" {
		t.Fatalf("unsafe error %q", err.Error())
	}
}
