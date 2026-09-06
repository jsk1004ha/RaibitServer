package backup

import (
	"errors"
	"strings"
	"testing"
)

func Test_SourceGeneration_when_Task22_canonical_value(t *testing.T) {
	// Given: Task22's exact canonical generation.
	// When: it crosses the adapter boundary.
	generation, err := NewSourceGeneration(testGeneration)
	// Then: the complete tagged digest is preserved.
	if err != nil || generation.String() != testGeneration {
		t.Fatalf("generation=%q err=%v", generation.String(), err)
	}
}

func Test_SourceGeneration_when_tag_or_digest_is_not_exact(t *testing.T) {
	// Given: malformed near-matches for the Task22 generation.
	values := []string{"sha256:" + strings.Repeat("a", 64), "resource-incarnation/v1:sha256:" + strings.Repeat("A", 64), "resource-incarnation/v1:sha256:" + strings.Repeat("a", 63)}
	// When / Then: none bind as source identity.
	for _, value := range values {
		if _, err := NewSourceGeneration(value); !errors.Is(err, ErrRecoveryRequest) {
			t.Fatalf("value=%q err=%v", value, err)
		}
	}
}

func Test_NewDumpRequest_when_claim_generation_differs(t *testing.T) {
	// Given: a connection bound to one server-owned incarnation.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	other, err := NewSourceGeneration("resource-incarnation/v1:sha256:" + strings.Repeat("c", 64))
	if err != nil {
		t.Fatal(err)
	}
	// When: a stale claim is bound.
	_, err = NewDumpRequest(source, other)
	// Then: dump construction fails closed.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewNetworkEndpoint_when_database_or_index_shape_is_invalid(t *testing.T) {
	// Given: endpoint states which mix or omit database/index identity.
	index := uint16(1)
	values := []NetworkEndpointSpec{{Host: "db.internal", Port: 5432}, {Host: "db.internal", Port: 5432, Database: "app", Index: &index}}
	// When / Then: the tagged endpoint parser rejects each state.
	for _, value := range values {
		if _, err := NewNetworkEndpoint(value); !errors.Is(err, ErrRecoveryRequest) {
			t.Fatalf("value=%+v err=%v", value, err)
		}
	}
}

func Test_NewSQLiteEndpoint_when_path_escapes_or_is_not_normalized(t *testing.T) {
	// Given: tenant paths that escape or alias the provider root.
	paths := []string{"../tenant.sqlite", "db/../tenant.sqlite", "/tenant.sqlite", "."}
	// When / Then: no unsafe path becomes a SQLite endpoint.
	for _, relative := range paths {
		_, err := NewSQLiteEndpoint(SQLiteEndpointSpec{Volume: "provider-data", Root: "sqlite-root", RelativePath: relative})
		if !errors.Is(err, ErrRecoveryRequest) {
			t.Fatalf("path=%q err=%v", relative, err)
		}
	}
}

func Test_NewRestoreRequest_when_same_secret_object_uses_different_key(t *testing.T) {
	// Given: distinct endpoints whose credentials alias one Kubernetes Secret object.
	source := testNetworkConnection(t, "source", "source.db.internal", "shared-secret", "SOURCE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "shared-secret", "TARGET_URL", "16.7")
	artifact := testArtifact(t, source)
	// When: restore separation is checked.
	_, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	// Then: different keys do not bypass object-level isolation.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}

func Test_NewRestoreRequest_when_adapter_policy_allows_patch_upgrade(t *testing.T) {
	// Given: one engine major with different source and target patches.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "16.7")
	artifact := testArtifact(t, source)
	// When: the format-specific major compatibility policy evaluates it.
	request, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	// Then: the compatible patch upgrade reaches the adapter.
	if err != nil || request.Target().Version() != "16.7" {
		t.Fatalf("target=%q err=%v", request.Target().Version(), err)
	}
}

func Test_NewRestoreRequest_when_adapter_policy_rejects_major_or_format(t *testing.T) {
	// Given: an artifact policy bound to its engine format.
	source := testNetworkConnection(t, "source", "source.db.internal", "source-secret", "DATABASE_URL", "16.4")
	target := testNetworkConnection(t, "target", "target.db.internal", "target-secret", "DATABASE_URL", "17.0")
	artifact := testArtifact(t, source)
	otherFormat, err := NewEngineFormat(EngineFormatSpec{Engine: EnginePostgreSQL, Name: "custom-dump", Version: 2})
	if err != nil {
		t.Fatal(err)
	}
	// When / Then: incompatible major and mismatched policy format both fail.
	for _, policy := range []VersionCompatibility{NewMajorVersionCompatibility(artifact.Format()), NewMajorVersionCompatibility(otherFormat)} {
		if _, restoreErr := NewRestoreRequest(source, target, artifact, policy); !errors.Is(restoreErr, ErrRecoveryRequest) {
			t.Fatalf("err=%v", restoreErr)
		}
	}
}

func Test_NewRestoreRequest_when_SQLite_identity_overlaps(t *testing.T) {
	// Given: distinct resources resolving to the same provider volume path.
	source := testSQLiteConnection(t, "source", "tenant/source.sqlite")
	target := testSQLiteConnection(t, "target", "tenant/source.sqlite")
	artifact := testArtifact(t, source)
	// When: restore isolation is bound.
	_, err := NewRestoreRequest(source, target, artifact, NewMajorVersionCompatibility(artifact.Format()))
	// Then: file identity overlap is rejected.
	if !errors.Is(err, ErrRecoveryRequest) {
		t.Fatalf("err=%v", err)
	}
}
