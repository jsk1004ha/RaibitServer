package controlplane

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type previewPostgresFixture struct {
	prefix, organizationID, projectID, serviceID, installationRowID string
	integrationID, repositoryRowID, installationID, repositoryID    string
	lineageID, jobID                                                string
}

func TestPostgresPreviewResolverClaimFenceRollbackAndCommit(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAIBITSERVER_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("preview resolver qualification requires RAIBITSERVER_TEST_POSTGRES_DSN")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := sql.Open(postgresDriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := NewPostgresStore(db)
	now := time.Now().UTC().Truncate(time.Millisecond)

	t.Run("concurrent claim and atomic observation", func(t *testing.T) {
		fixture := insertPreviewPostgresFixture(t, ctx, db, now, 1)
		defer cleanupPreviewPostgresFixture(t, db, fixture)
		start := make(chan struct{})
		claims := make(chan *PreviewResolutionClaim, 2)
		errorsFound := make(chan error, 2)
		var workers sync.WaitGroup
		for _, workerID := range []string{"resolver-a", "resolver-b"} {
			workers.Add(1)
			go func(worker string) {
				defer workers.Done()
				<-start
				claim, claimErr := store.ClaimNextPreviewResolution(ctx, worker, now)
				claims <- claim
				errorsFound <- claimErr
			}(workerID)
		}
		close(start)
		workers.Wait()
		close(claims)
		close(errorsFound)
		for claimErr := range errorsFound {
			if claimErr != nil {
				t.Fatal(claimErr)
			}
		}
		var winner *PreviewResolutionClaim
		claimed := 0
		for claim := range claims {
			if claim != nil {
				winner = claim
				claimed++
			}
		}
		if claimed != 1 || winner == nil || winner.Attempt != 1 || winner.DeadlineAt.Sub(now) != PreviewDeadline {
			t.Fatalf("concurrent resolver claims=%d winner=%+v", claimed, winner)
		}
		stale := *winner
		stale.ClaimToken = "00000000-0000-4000-8000-000000000000"
		if err := store.RenewPreviewResolutionLease(ctx, stale, now.Add(time.Second)); !errors.Is(err, ErrPreviewResolutionLeaseLost) {
			t.Fatalf("stale claim token renewed lease: %v", err)
		}
		observation := fixtureObservation(fixture, now)
		applied, err := store.CommitPreviewResolution(ctx, *winner, observation, now.Add(2*time.Second))
		if err != nil || !applied {
			t.Fatalf("commit observation: applied=%v err=%v", applied, err)
		}
		var observationCount, applyCount int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "PreviewLineage" WHERE id=$1 AND "resolutionObservation"->>'headSha'=$2`, fixture.lineageID, observation.HeadSHA).Scan(&observationCount); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "WorkflowJob" WHERE id=$1 AND type='github.preview-apply' AND status='queued'`, fmt.Sprintf("preview-apply:%s:1", fixture.lineageID)).Scan(&applyCount); err != nil {
			t.Fatal(err)
		}
		if observationCount != 1 || applyCount != 1 {
			t.Fatalf("atomic resolver completion observation=%d apply=%d", observationCount, applyCount)
		}
	})

	t.Run("apply collision rolls back observation", func(t *testing.T) {
		fixture := insertPreviewPostgresFixture(t, ctx, db, now.Add(time.Minute), 1)
		defer cleanupPreviewPostgresFixture(t, db, fixture)
		claim, err := store.ClaimNextPreviewResolution(ctx, "resolver-c", now.Add(time.Minute))
		if err != nil || claim == nil {
			t.Fatalf("claim collision fixture: %+v %v", claim, err)
		}
		applyID := fmt.Sprintf("preview-apply:%s:1", fixture.lineageID)
		if _, err := db.ExecContext(ctx, `INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,"updatedAt") VALUES ($1,'foreign','queued','preview-lineage',$2,'{}',$3)`, applyID, fixture.lineageID, now); err != nil {
			t.Fatal(err)
		}
		if applied, err := store.CommitPreviewResolution(ctx, *claim, fixtureObservation(fixture, now), now.Add(time.Minute+time.Second)); err == nil || applied {
			t.Fatalf("mismatched apply collision was accepted: applied=%v err=%v", applied, err)
		}
		var persisted int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "PreviewLineage" WHERE id=$1 AND "resolutionObservation" IS NOT NULL`, fixture.lineageID).Scan(&persisted); err != nil {
			t.Fatal(err)
		}
		if persisted != 0 {
			t.Fatal("failed apply enqueue did not roll back observation")
		}
	})

	t.Run("lineage version race cancels stale result", func(t *testing.T) {
		fixture := insertPreviewPostgresFixture(t, ctx, db, now.Add(2*time.Minute), 1)
		defer cleanupPreviewPostgresFixture(t, db, fixture)
		claim, err := store.ClaimNextPreviewResolution(ctx, "resolver-d", now.Add(2*time.Minute))
		if err != nil || claim == nil {
			t.Fatalf("claim stale fixture: %+v %v", claim, err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE "PreviewLineage" SET version=2,"updatedAt"=$2 WHERE id=$1`, fixture.lineageID, now.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		applied, err := store.CommitPreviewResolution(ctx, *claim, fixtureObservation(fixture, now), now.Add(2*time.Minute+time.Second))
		if err != nil || applied {
			t.Fatalf("stale result did not cancel safely: applied=%v err=%v", applied, err)
		}
		var status string
		var observations, applies int
		if err := db.QueryRowContext(ctx, `SELECT status FROM "WorkflowJob" WHERE id=$1`, fixture.jobID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "PreviewLineage" WHERE id=$1 AND "resolutionObservation" IS NOT NULL`, fixture.lineageID).Scan(&observations); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "WorkflowJob" WHERE id=$1`, fmt.Sprintf("preview-apply:%s:1", fixture.lineageID)).Scan(&applies); err != nil {
			t.Fatal(err)
		}
		if status != "cancelled" || observations != 0 || applies != 0 {
			t.Fatalf("stale result mutated state: status=%s observations=%d applies=%d", status, observations, applies)
		}
	})
}

func insertPreviewPostgresFixture(t *testing.T, ctx context.Context, db *sql.DB, now time.Time, version int) previewPostgresFixture {
	t.Helper()
	uuid, err := newPreviewClaimToken()
	if err != nil {
		t.Fatal(err)
	}
	prefix := "preview-" + uuid
	compactUUID := strings.ReplaceAll(uuid, "-", "")
	fixture := previewPostgresFixture{
		prefix: prefix, organizationID: prefix + "-org", projectID: prefix + "-project", serviceID: prefix + "-service",
		installationRowID: prefix + "-installation", integrationID: prefix + "-integration", repositoryRowID: prefix + "-repository",
		installationID: compactUUID[:15], repositoryID: compactUUID[15:30], lineageID: prefix + "-lineage",
	}
	fixture.installationID = numericFixtureID(fixture.installationID)
	fixture.repositoryID = numericFixtureID(fixture.repositoryID)
	fixture.jobID = fmt.Sprintf("preview-resolve:%s:%d", fixture.lineageID, version)
	desiredState := fmt.Sprintf(`{"github":{"integrationId":%q,"installationId":%q,"repositoryId":%q,"repository":"trusted/repo"}}`, fixture.integrationID, fixture.installationID, fixture.repositoryID)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ($1,$1,$1,$2)`, fixture.organizationID, now)
	exec(`INSERT INTO "Project" (id,"organizationId",name,slug,status,"updatedAt") VALUES ($1,$2,$1,$1,'ACTIVE',$3)`, fixture.projectID, fixture.organizationID, now)
	exec(`INSERT INTO "GitHubInstallation" (id,"installationId","accountLogin","accountType","updatedAt") VALUES ($1,$2,$1,'Organization',$3)`, fixture.installationRowID, fixture.installationID, now)
	exec(`INSERT INTO "GitHubIntegration" (id,"organizationId","installationId","verifiedAt","updatedAt") VALUES ($1,$2,$3,$4,$4)`, fixture.integrationID, fixture.organizationID, fixture.installationID, now)
	exec(`INSERT INTO "GitHubRepository" (id,"installationId","githubRepoId",owner,name,"fullName",private,"updatedAt") VALUES ($1,$2,$3,'trusted','repo','trusted/repo',TRUE,$4)`, fixture.repositoryRowID, fixture.installationID, fixture.repositoryID, now)
	exec(`INSERT INTO "Service" (id,"projectId",name,slug,type,"sourceType","githubRepositoryId","desiredState",status,"updatedAt") VALUES ($1,$2,$1,$1,'web','github',$3,$4::jsonb,'CREATED',$5)`, fixture.serviceID, fixture.projectID, fixture.repositoryID, desiredState, now)
	exec(`INSERT INTO "PreviewLineage" (id,"organizationId","projectId","serviceId","integrationId","installationId","repositoryId",repository,"pullRequestNumber","stableHost",namespace,"routeName",state,version,generation,"eventUpdatedAt","eventAction","headSha","headRef","baseRef","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'trusted/repo',17,$8,$9,$10,'AMBIGUOUS',$11,0,$12,'opened',$13,'feature/preview','main',$12)`, fixture.lineageID, fixture.organizationID, fixture.projectID, fixture.serviceID, fixture.integrationID, fixture.installationID, fixture.repositoryID, "preview--"+uuid+".example.test", "preview-"+uuid[:8], "route-"+uuid[:8], version, now, strings.Repeat("a", 40))
	exec(`INSERT INTO "WorkflowJob" (id,type,status,"targetType","targetId",payload,attempts,"maxAttempts","runAfter","updatedAt") VALUES ($1,'github.preview-resolve','queued','preview-lineage',$2,jsonb_build_object('version',1,'lineageId',$2::text,'lineageVersion',$3::int),0,3,$4,$4)`, fixture.jobID, fixture.lineageID, version, now)
	return fixture
}

func cleanupPreviewPostgresFixture(t *testing.T, db *sql.DB, fixture previewPostgresFixture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, query := range []string{
		`DELETE FROM "WorkflowJob" WHERE "targetId"=$1`, `DELETE FROM "PreviewLineage" WHERE id=$1`, `DELETE FROM "Service" WHERE id=$1`,
		`DELETE FROM "GitHubRepository" WHERE id=$1`, `DELETE FROM "GitHubIntegration" WHERE id=$1`, `DELETE FROM "GitHubInstallation" WHERE id=$1`,
		`DELETE FROM "Project" WHERE id=$1`, `DELETE FROM "Organization" WHERE id=$1`,
	} {
		var id string
		switch {
		case strings.Contains(query, "WorkflowJob"), strings.Contains(query, "PreviewLineage"):
			id = fixture.lineageID
		case strings.Contains(query, "Service"):
			id = fixture.serviceID
		case strings.Contains(query, "GitHubRepository"):
			id = fixture.repositoryRowID
		case strings.Contains(query, "GitHubIntegration"):
			id = fixture.integrationID
		case strings.Contains(query, "GitHubInstallation"):
			id = fixture.installationRowID
		case strings.Contains(query, "Project"):
			id = fixture.projectID
		default:
			id = fixture.organizationID
		}
		if _, err := db.ExecContext(ctx, query, id); err != nil {
			t.Errorf("preview fixture cleanup: %v", err)
		}
	}
}

func fixtureObservation(fixture previewPostgresFixture, now time.Time) PreviewResolutionObservation {
	return PreviewResolutionObservation{Version: 1, LineageID: fixture.lineageID, LineageVersion: 1, InstallationID: fixture.installationID, RepositoryID: fixture.repositoryID, PullRequestNumber: 17, State: "open", HeadSHA: strings.Repeat("b", 40), HeadRef: "feature/preview", BaseRef: "main", UpdatedAt: now, ObservedAt: now.Add(time.Second)}
}

func numericFixtureID(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if character >= '0' && character <= '9' {
			builder.WriteRune(character)
		} else {
			builder.WriteByte(byte('1' + (character-'a')%9))
		}
	}
	result := strings.TrimLeft(builder.String(), "0")
	if result == "" {
		return "1"
	}
	return result
}
