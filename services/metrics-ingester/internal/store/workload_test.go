//go:build integration

package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
	"github.com/raibitserver/metrics-ingester/internal/ingester"
	"github.com/raibitserver/metrics-ingester/internal/kube"
)

func TestJobAndCronAuthenticatedOwnerChains(t *testing.T) {
	for _, kind := range []string{"job", "cron"} {
		t.Run(kind, func(t *testing.T) {
			// Given: desired job/cron shape and its real Kubernetes controller chain.
			p, r := fixtureStore(t)
			if _, err := p.db.ExecContext(t.Context(), `UPDATE "Deployment" SET "desiredSpecSnapshot"=jsonb_build_object('type',$2::text) WHERE id=$1`, r.DeploymentID, kind); err != nil {
				t.Fatal(err)
			}
			var err error
			r.Scope, err = p.Resolve(t.Context(), r.DeploymentID)
			if err != nil {
				t.Fatal(err)
			}
			f := newHTTPFixture(r)
			f.Workload.APIVersion = "batch/v1"
			f.Workload.Kind = r.Scope.Kind
			if kind == "job" {
				f.Pod.Metadata.Owners = []wireOwner{{"batch/v1", "Job", r.Scope.WorkloadName, "workload-uid", true}}
			} else {
				f.Middle.APIVersion = "batch/v1"
				f.Middle.Kind = "Job"
				f.Middle.Metadata.Owners = []wireOwner{{"batch/v1", "CronJob", r.Scope.WorkloadName, "workload-uid", true}}
				f.Pod.Metadata.Owners = []wireOwner{{"batch/v1", "Job", f.Middle.Metadata.Name, "rs-uid", true}}
				f.Workload.Spec = wireSpec{JobTemplate: &wireJobTemplate{Spec: wireSpec{Template: f.Workload.Spec.Template}}}
			}
			f.server(t)
			source, err := kube.NewFromEnvironment()
			if err != nil {
				t.Fatal(err)
			}
			// When: the production worker follows the actual namespaced owners.
			out, err := ingester.New(ingester.Config{}, source, p).RunOnce(t.Context(), time.Now().UTC())
			// Then: current diagnostic metrics persist without a readiness gate.
			if err != nil || out.Inserted != 2 {
				t.Fatalf("owner chain rejected: %#v %v", out, err)
			}
			f.capture(t)
		})
	}
}

func TestImmutableEnvironmentAndSecretReferenceIdentity(t *testing.T) {
	for _, variant := range []string{"valid", "env_tampered", "secret_ref_tampered", "duplicate_env", "unknown_env_field"} {
		t.Run(variant, func(t *testing.T) {
			// Given: immutable environment, exact secret reference, command/args and injected commit.
			p, r := fixtureStore(t)
			const snapshot = `{"type":"web","command":["node"],"args":["server.js"],"env":{"MODE":"test"},"secretEnv":[{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"runtime-db","key":"URL"}}}]}`
			if _, err := p.db.ExecContext(t.Context(), `UPDATE "Deployment" SET "desiredSpecSnapshot"=$2::jsonb,"commitSha"='abc123' WHERE id=$1`, r.DeploymentID, snapshot); err != nil {
				t.Fatal(err)
			}
			var err error
			r.Scope, err = p.Resolve(t.Context(), r.DeploymentID)
			if err != nil {
				t.Fatal(err)
			}
			f := newHTTPFixture(r)
			var secret identity.EnvironmentEntry
			if err = json.Unmarshal([]byte(`{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"runtime-db","key":"URL"}}}`), &secret); err != nil {
				t.Fatal(err)
			}
			c := &f.Pod.Spec.Containers[0]
			c.Command = []string{"node"}
			c.Args = []string{"server.js"}
			c.Env = append(c.Env, identity.EnvironmentEntry{Name: "MODE", Value: "test"}, identity.EnvironmentEntry{Name: "RAIBITSERVER_GIT_SHA", Value: "abc123"}, secret)
			switch variant {
			case "valid":
			case "env_tampered":
				c.Env[4].Value = "changed"
			case "secret_ref_tampered":
				c.Env[6].ValueFrom.SecretKeyRef.Key = "OTHER"
			case "duplicate_env":
				c.Env = append(c.Env, c.Env[0])
			case "unknown_env_field":
				if err = json.Unmarshal([]byte(`{"name":"MODE","value":"test","unknown":"field"}`), &secret); err == nil {
					t.Fatal("unknown env field accepted")
				}
				return
			}
			f.server(t)
			source, err := kube.NewFromEnvironment()
			if err != nil {
				t.Fatal(err)
			}
			// When: comparing the observed container and templates against the immutable digest.
			out, err := ingester.New(ingester.Config{}, source, p).RunOnce(t.Context(), time.Now().UTC())
			// Then: order-independent exact shape succeeds; changed/duplicate identity is denied.
			want := 0
			if variant == "valid" {
				want = 2
			}
			if err != nil || out.Inserted != want {
				t.Fatalf("environment outcome=%#v err=%v", out, err)
			}
			f.capture(t)
		})
	}
}
