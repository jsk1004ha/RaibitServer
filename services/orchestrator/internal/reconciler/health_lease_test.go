package reconciler

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/raibitserver/orchestrator/internal/command"
	"github.com/raibitserver/orchestrator/internal/health"
	"github.com/raibitserver/orchestrator/internal/store"
)

func TestHealthHappyLeaseRenewsWhileChecking(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Given: a deterministic checker fixture outlasts one30s lease.
		r, file, _ := readyHealth(t)
		r.checker = healthCheckFunc(func(ctx context.Context, _ health.Request) health.Result {
			timer := time.NewTimer(31 * time.Second)
			defer timer.Stop()
			select {
			case <-timer.C:
				return health.Result{Status: "HEALTHY"}
			case <-ctx.Done():
				return health.Result{Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_CANCELLED"}
			}
		})
		// When
		_, err := r.RunOnceResult(context.Background())
		// Then: renewal kept durable ownership across the initial expiry.
		if err != nil {
			t.Fatal(err)
		}
		row := firstByID(t, readState(t, file), "deployments", "dep_1")
		if row["publicHealthStatus"] != "HEALTHY" {
			t.Fatalf("lease was not renewed: %#v", row)
		}
	})
}

type stalledHealthIdentity struct{ command.Runner }

func (runner stalledHealthIdentity) Run(ctx context.Context, spec command.Command, dryRun bool, timeout time.Duration) (command.Result, error) {
	if len(spec.Args) > 1 && spec.Args[0] == "get" && strings.HasPrefix(spec.Args[1], "deployment/") {
		<-ctx.Done()
		return command.Result{}, ctx.Err()
	}
	return runner.Runner.Run(ctx, spec, dryRun, timeout)
}

func TestHealthFailureMatrixExpiryIdentityFailureIsBoundedAndNeverPublishes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Given
		r, file, runner := readyHealth(t)
		now := time.Now().UTC().Add(181 * time.Second)
		r.now = func() time.Time { return now }
		r.runner = stalledHealthIdentity{Runner: runner}
		r.checker = healthCheckFunc(func(context.Context, health.Request) health.Result {
			t.Fatal("expired job called checker")
			return health.Result{}
		})
		started := time.Now()
		// When
		_, err := r.RunOnceResult(context.Background())
		// Then
		if err != nil {
			t.Fatal(err)
		}
		if time.Since(started) > 3*time.Second {
			t.Fatalf("identity fence exceeded3s: %s", time.Since(started))
		}
		row := firstByID(t, readState(t, file), "deployments", "dep_1")
		if row["publicHealthStatus"] != "UNKNOWN" || row["healthCheckedAt"] != nil {
			t.Fatalf("unconfirmed expiry published: %#v", row)
		}
	})
}

type rejectingHealthRenewal struct {
	store.ReconcileStore
	calls atomic.Int32
}

func (state *rejectingHealthRenewal) RenewHealthLease(ctx context.Context, lease store.HealthLease, now time.Time) error {
	if state.calls.Add(1) > 1 {
		return store.ErrHealthLeaseLost
	}
	return state.ReconcileStore.RenewHealthLease(ctx, lease, now)
}

func TestHealthFailureMatrixLostHeartbeatCancelsInFlightCheck(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Given
		r, file, _ := readyHealth(t)
		r.store = &rejectingHealthRenewal{ReconcileStore: r.store}
		cancelled := false
		r.checker = healthCheckFunc(func(ctx context.Context, _ health.Request) health.Result {
			<-ctx.Done()
			cancelled = true
			return health.Result{Status: "DEGRADED", FailureCode: "PUBLIC_HEALTH_CANCELLED"}
		})
		// When
		_, err := r.RunOnceResult(context.Background())
		// Then
		if !errors.Is(err, store.ErrHealthLeaseLost) || !cancelled {
			t.Fatalf("heartbeat failure=%v cancelled=%t", err, cancelled)
		}
		row := firstByID(t, readState(t, file), "deployments", "dep_1")
		if row["healthCheckedAt"] != nil || row["publicHealthStatus"] == "HEALTHY" {
			t.Fatalf("lost worker published: %#v", row)
		}
	})
}
