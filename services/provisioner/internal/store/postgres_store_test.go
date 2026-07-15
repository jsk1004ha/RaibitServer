package store

import (
	"strings"
	"testing"
)

func TestClaimResourceSQLUsesAtomicSkipLockedClaimAndLeaseRecovery(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimResourceSQL), " ")
	for _, fragment := range []string{"FOR UPDATE OF r SKIP LOCKED", `UPPER(r.status) = $1`, `UPPER(r.status) = $2`, `claimHeartbeatUnixMs`, `lastDryRunAt`, `EXTRACT(EPOCH FROM clock_timestamp())`, `$3::numeric`, `$4::numeric`, `ORDER BY r."updatedAt" ASC, r."createdAt" ASC, r.id ASC`} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("claim SQL missing %q in %s", fragment, normalized)
		}
	}
	// Resource creation historically persisted lowercase statuses. The expression
	// index in migration 000007 keeps this compatibility predicate indexable.
}

func TestReadyHealthClaimIsPeriodicAtomicAndTombstoneSafe(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimReadyResourceSQL), " ")
	for _, fragment := range []string{"FOR UPDATE OF r SKIP LOCKED", `UPPER(r.status) = 'READY'`, `UPPER(r.status) = 'FAILED'`, `r."desiredState"->>'healthManaged'`, `r."connectionSecretName" IS NOT NULL`, `clock_timestamp() AT TIME ZONE 'UTC'`, `$1::bigint * interval '1 millisecond'`, `r."deletionRequestedAt" IS NULL`, `p."deletionRequestedAt" IS NULL`} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("READY health claim SQL missing %q in %s", fragment, normalized)
		}
	}
}

func TestDeletionClaimSQLRunsBeforeProvisioningAndRecoversStaleLeases(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimResourceDeletionSQL), " ")
	for _, fragment := range []string{"FOR UPDATE OF r SKIP LOCKED", `UPPER(r.status) = $1`, `UPPER(r.status) = $2`, `claimHeartbeatUnixMs`, `lastDryRunDeletionAt`, `EXTRACT(EPOCH FROM clock_timestamp())`, `$3::numeric`, `$4::numeric`, `r."connectionSecretName"`, `ORDER BY r."updatedAt" ASC, r."createdAt" ASC, r.id ASC`} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("deletion claim SQL missing %q in %s", fragment, normalized)
		}
	}
}

func TestClaimTokensUseTheDatabaseClockAndReturnThePersistedCASValue(t *testing.T) {
	for name, statement := range map[string]string{
		"provisioning/health": claimResourceUpdateSQL,
		"deletion":            claimResourceDeletionUpdateSQL,
	} {
		normalized := strings.Join(strings.Fields(statement), " ")
		for _, fragment := range []string{`clock_timestamp() AT TIME ZONE 'UTC'`, `UPPER(status) = $3`, `RETURNING "updatedAt"`} {
			if !strings.Contains(normalized, fragment) {
				t.Fatalf("%s claim update must use one database clock and return its CAS token; missing %q in %s", name, fragment, normalized)
			}
		}
	}
}

func TestClaimHeartbeatAndCredentialIdentityUpdatesKeepOriginalCASFence(t *testing.T) {
	renew := strings.Join(strings.Fields(renewResourceClaimSQL), " ")
	reserve := strings.Join(strings.Fields(reserveCredentialSecretGenerationSQL), " ")
	persist := strings.Join(strings.Fields(persistCredentialSecretUIDSQL), " ")
	for name, statement := range map[string]string{"renew": renew, "reserve credential generation": reserve, "persist credential UID": persist} {
		for _, fragment := range []string{`"updatedAt" = $`, `claimHeartbeatUnixMs`, `status = $`, `clock_timestamp()`} {
			if !strings.Contains(statement, fragment) {
				t.Fatalf("%s SQL is missing claim fence %q: %s", name, fragment, statement)
			}
		}
		if strings.Contains(statement, `SET "updatedAt"`) || strings.Contains(statement, `, "updatedAt"`) {
			t.Fatalf("%s must not replace the original claim token: %s", name, statement)
		}
	}
	for _, fragment := range []string{`credentialSecretGeneration`, `NOT (COALESCE("desiredState", '{}'::jsonb) ? 'credentialSecretGeneration')`, `"desiredState"->>'credentialSecretGeneration' = $1`} {
		if !strings.Contains(reserve, fragment) {
			t.Fatalf("credential generation reservation must be immutable and idempotent; missing %q in %s", fragment, reserve)
		}
	}
	if !strings.Contains(persist, `credentialSecretUID`) {
		t.Fatalf("credential identity persistence is missing the exact metadata key: %s", persist)
	}
	for _, fragment := range []string{`NOT (COALESCE("desiredState", '{}'::jsonb) ? 'credentialSecretUID')`, `"desiredState"->>'credentialSecretUID' = $1`} {
		if !strings.Contains(persist, fragment) {
			t.Fatalf("credential identity must be immutable and idempotent; missing %q in %s", fragment, persist)
		}
	}
}

func TestProviderIdentityIsPersistedBeforeSideEffectsWithAnImmutableClaimFence(t *testing.T) {
	persist := strings.Join(strings.Fields(persistProviderIdentitySQL), " ")
	for _, fragment := range []string{
		`providerIdentity`, `claimHeartbeatUnixMs`, `clock_timestamp()`, `status = $3`, `"updatedAt" = $4`,
		`NOT (COALESCE("desiredState", '{}'::jsonb) ? 'providerIdentity')`, `"desiredState"->'providerIdentity' = $1::jsonb`,
	} {
		if !strings.Contains(persist, fragment) {
			t.Fatalf("provider identity persistence is missing %q: %s", fragment, persist)
		}
	}
	if strings.Contains(persist, `SET "updatedAt"`) || strings.Contains(persist, `, "updatedAt"`) {
		t.Fatalf("provider identity persistence must retain the original claim CAS token: %s", persist)
	}
}

func TestCredentialSecretUIDIsPreservedWhileSecretValuesRemainMasked(t *testing.T) {
	masked := maskSecrets(map[string]any{
		"credentialSecretUID":        "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21",
		"credentialSecretGeneration": "dGhpcy1pcy1hLTMyaWJ5dGUtcmFuZG9tLW5vbmNlMDA",
		"credentialSecret":           "must-be-redacted",
	}).(map[string]any)
	if masked["credentialSecretUID"] != "5c0c1aa2-e18f-43be-9dc7-3dfbf158cd21" || masked["credentialSecretGeneration"] != "dGhpcy1pcy1hLTMyaWJ5dGUtcmFuZG9tLW5vbmNlMDA" || masked["credentialSecret"] != "****" {
		t.Fatalf("only exact non-secret identity metadata may bypass masking: %#v", masked)
	}
}

func TestResourceFinalizationIsConditionalAndDeletesProviderMetadataLast(t *testing.T) {
	normalized := strings.Join(strings.Fields(finalizeResourceDeletionSQL), " ")
	secret := strings.Index(normalized, `DELETE FROM "SecretValue"`)
	resource := strings.Index(normalized, `DELETE FROM "Resource"`)
	if secret < 0 || resource < 0 || secret > resource {
		t.Fatalf("provider secrets must be removed before the conditional resource finalization: %s", normalized)
	}
	if !strings.Contains(normalized, `status = 'DELETING'`) {
		t.Fatalf("resource finalization must be conditional on DELETING: %s", normalized)
	}
	if !strings.Contains(normalized, `"updatedAt" = $2`) {
		t.Fatalf("resource finalization must be fenced by the active deletion claim: %s", normalized)
	}
}

func TestReadyTransitionIsLeaseAndTombstoneFenced(t *testing.T) {
	normalized := strings.Join(strings.Fields(markResourceReadySQL), " ")
	for _, fragment := range []string{
		`r.status = 'RECONCILING'`,
		`r."updatedAt" = $`,
		`r."deletionRequestedAt" IS NULL`,
		`p."deletionRequestedAt" IS NULL`,
		`UPPER(p.status) NOT IN ('DELETE_REQUESTED', 'DELETING')`,
		`"connectionSecretName"`,
		`clock_timestamp() AT TIME ZONE 'UTC'`,
	} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("READY transition is missing fence %q: %s", fragment, normalized)
		}
	}
}

func TestNonReadyClaimTransitionsAreAlsoLeaseFenced(t *testing.T) {
	normalized := strings.Join(strings.Fields(transitionResourceSQL), " ")
	for _, fragment := range []string{
		`status = $4`,
		`"updatedAt" = $5`,
		`clock_timestamp() AT TIME ZONE 'UTC'`,
	} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("claimed transition is missing lease fence %q: %s", fragment, normalized)
		}
	}
}
