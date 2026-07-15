package store

import (
	"strings"
	"testing"
)

func TestClaimDeploymentSQLUsesAtomicSkipLockedClaim(t *testing.T) {
	normalized := strings.Join(strings.Fields(claimDeploymentSQL), " ")
	for _, fragment := range []string{"FOR UPDATE OF d SKIP LOCKED", `d.status IN ($1, $2, $3, $4)`, `d.status = $5`, `d."reconcileLockedAt" <= $6`, `d."reconcileAction" IN`, `JOIN "Service" s`, `JOIN "Project" p`, `UPPER(s.status) NOT IN`, `UPPER(p.status) NOT IN`} {
		if !strings.Contains(normalized, fragment) {
			t.Fatalf("claim SQL missing %q in %s", fragment, normalized)
		}
	}
}

func TestDeletionClaimSQLUsesLeasedSkipLockedRowsAndProjectChildBarrier(t *testing.T) {
	for name, query := range map[string]string{"service": claimServiceDeletionSQL, "project": claimProjectDeletionSQL} {
		normalized := strings.Join(strings.Fields(query), " ")
		for _, fragment := range []string{`DELETE_REQUESTED`, `DELETING`, `"updatedAt" <=`, `FOR UPDATE OF`, `SKIP LOCKED`} {
			if !strings.Contains(normalized, fragment) {
				t.Fatalf("%s deletion claim SQL missing %q in %s", name, fragment, normalized)
			}
		}
	}
	project := strings.Join(strings.Fields(claimProjectDeletionSQL), " ")
	for _, fragment := range []string{`NOT EXISTS (SELECT 1 FROM "Service"`, `NOT EXISTS (SELECT 1 FROM "Resource"`} {
		if !strings.Contains(project, fragment) {
			t.Fatalf("project deletion claim must wait for children: missing %q in %s", fragment, project)
		}
	}
}

func TestDeletionClaimLeaseUsesDatabaseStoredTimestamp(t *testing.T) {
	for name, query := range map[string]string{
		"service": claimServiceDeletionLeaseSQL,
		"project": claimProjectDeletionLeaseSQL,
	} {
		normalized := strings.Join(strings.Fields(query), " ")
		if !strings.Contains(normalized, `RETURNING "updatedAt"`) {
			t.Fatalf("%s deletion claim must return the database-normalized lease timestamp: %s", name, normalized)
		}
	}
}

func TestDeletionFinalizersFenceLeaseAndActiveDeploymentRaces(t *testing.T) {
	service := strings.Join(strings.Fields(finalizeServiceDeletionSQL), " ")
	for _, fragment := range []string{`status = 'DELETING'`, `"updatedAt" = $2`, `NOT EXISTS`, `"reconcileLockedBy" IS NOT NULL`, `status NOT IN`} {
		if !strings.Contains(service, fragment) {
			t.Fatalf("service deletion finalizer missing %q in %s", fragment, service)
		}
	}
	project := strings.Join(strings.Fields(finalizeProjectDeletionSQL), " ")
	for _, fragment := range []string{`status = 'DELETING'`, `"updatedAt" = $2`, `NOT EXISTS (SELECT 1 FROM "Service"`, `NOT EXISTS (SELECT 1 FROM "Resource"`} {
		if !strings.Contains(project, fragment) {
			t.Fatalf("project deletion finalizer missing %q in %s", fragment, project)
		}
	}
	ready := strings.Join(strings.Fields(readyTransitionParentPredicate), " ")
	for _, fragment := range []string{`"Service"`, `"Project"`, `NOT IN`} {
		if !strings.Contains(ready, fragment) {
			t.Fatalf("READY transition parent fence missing %q in %s", fragment, ready)
		}
	}
}

func TestDeploymentLeaseSQLFencesOwnerActionAndAttempt(t *testing.T) {
	for name, query := range map[string]string{"renew": renewDeploymentLeaseSQL, "transition": transitionDeploymentLeasePredicate} {
		normalized := strings.Join(strings.Fields(query), " ")
		for _, fragment := range []string{`status =`, `"reconcileLockedBy" =`, `"reconcileAttempts" =`, `"reconcileAction" =`} {
			if !strings.Contains(normalized, fragment) {
				t.Fatalf("%s lease SQL missing %q in %s", name, fragment, normalized)
			}
		}
	}
}

func TestPostgresDeploymentUpdatesAreWhitelisted(t *testing.T) {
	assignments, _, err := postgresUpdateAssignments(map[string]any{"status": DeploymentStatusReady, "finishedAt": "2026-01-01T00:00:00Z"})
	if err != nil || strings.Join(assignments, ",") != `"finishedAt" = $1,status = $2` {
		t.Fatalf("unexpected deterministic assignments: %#v, %v", assignments, err)
	}
	if _, _, err := postgresUpdateAssignments(map[string]any{"desiredState": map[string]any{}}); err == nil {
		t.Fatal("unsupported update must fail closed")
	}
}

func TestProjectRoutingQueryCarriesCanonicalIdentity(t *testing.T) {
	projectQuery := strings.Join(strings.Fields(getProjectSQL), " ")
	for _, fragment := range []string{`JOIN "Organization" o`, `o.slug AS "organizationSlug"`} {
		if !strings.Contains(projectQuery, fragment) {
			t.Fatalf("project lookup must carry organization slug %q in %s", fragment, projectQuery)
		}
	}
}
