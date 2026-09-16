package backup

import (
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Mirrors Kubernetes IsLabelValue, not an API-server schema test:
// https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/#syntax-and-character-set
var kubernetesLabelValue = regexp.MustCompile(`^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$`)

func TestRecoveryLabelSchema(t *testing.T) {
	for _, engine := range []Engine{EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB, EngineRedis, EngineValkey} {
		for _, binding := range []StreamBinding{StreamStdout, StreamStdin} {
			t.Run(string(engine)+"/"+map[StreamBinding]string{StreamStdout: "backup", StreamStdin: "restore"}[binding], func(t *testing.T) {
				// Given: the real validated engine job and its unmodified canonical identity.
				base := testRecoveryJobForEngine(t, engine, recoveryProviderPort(engine))
				job, err := NewIsolatedJob(testJobSpec(t, base.spec.Connection, binding))
				if err != nil {
					t.Fatal(err)
				}
				if engine == EnginePostgreSQL {
					want := map[StreamBinding]string{
						StreamStdout: "recovery-job/v1:sha256:289da4ccb0065058c2aa0265bb9a4b9cbc8720b7a044dcf099c9c137d7d31c13",
						StreamStdin:  "recovery-job/v1:sha256:16a4de949f7fcd0ba48e5baf55d77d9484af81dabe1e40d799222e2da3efb87c",
					}[binding]
					if job.Identity() != want {
						t.Fatal("pre-change canonical backup/restore identity changed")
					}
				}
				names := recoveryObjectNames(job)
				source := kubernetesSecret{Data: map[string]string{job.spec.Connection.spec.Secret.key: "ZmFrZQ=="}}
				source.Metadata.UID, source.Metadata.ResourceVersion = "source-uid", "19"
				// When: all three runtime objects and the Pod selector are generated.
				snapshot, err := recoveryCredentialSnapshot(job, source, names.snapshot)
				if err != nil {
					t.Fatal(err)
				}
				manifest, _, err := recoveryJobManifest(job, names.job, names.snapshot, "snapshot-uid")
				if err != nil {
					t.Fatal(err)
				}
				policy := recoveryNetworkPolicyManifest(job, names.policy, strings.Repeat("a", 32))
				// Then: every label value, including selectors, is Kubernetes-valid.
				for _, object := range []map[string]any{snapshot, manifest, policy} {
					payload, err := json.Marshal(object)
					if err != nil {
						t.Fatal(err)
					}
					var normalized any
					if err := json.Unmarshal(payload, &normalized); err != nil {
						t.Fatal(err)
					}
					checkGeneratedLabelValues(t, normalized, object["kind"].(string))
				}
				podLabels := manifest["spec"].(map[string]any)["template"].(map[string]any)["metadata"].(map[string]any)["labels"].(map[string]string)
				selector := policy["spec"].(map[string]any)["podSelector"].(map[string]any)["matchLabels"].(map[string]string)
				for key, value := range selector {
					if podLabels[key] != value || job.Labels()[key] != value {
						t.Errorf("selector/constructor label differs at %s", key)
					}
				}
				label := selector["raibitserver.io/spec-identity"]
				digest, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimPrefix(label, "rj1-")))
				if err != nil || len(digest) != 32 || "recovery-job/v1:sha256:"+hex.EncodeToString(digest) != job.Identity() {
					t.Errorf("label must encode all 256 canonical digest bits: %q", label)
				}
			})
		}
	}
}

func checkGeneratedLabelValues(t *testing.T, node any, path string) {
	t.Helper()
	switch value := node.(type) {
	case map[string]any:
		for key, child := range value {
			if key == "labels" || key == "matchLabels" {
				for label, raw := range child.(map[string]any) {
					text := raw.(string)
					if len(text) > 63 || !kubernetesLabelValue.MatchString(text) {
						t.Errorf("%s.%s[%s]: invalid Kubernetes label value %q (%d bytes)", path, key, label, text, len(text))
					}
				}
			}
			checkGeneratedLabelValues(t, child, path+"."+key)
		}
	case []any:
		for _, child := range value {
			checkGeneratedLabelValues(t, child, path+"[]")
		}
	}
}

func TestRecoveryCanonicalIdentityCompletion(t *testing.T) {
	// Given: a fixed pre-change identity and the real generated Job representation.
	job := testRecoveryJobForEngine(t, EnginePostgreSQL, 5432)
	const canonical = "recovery-job/v1:sha256:289da4ccb0065058c2aa0265bb9a4b9cbc8720b7a044dcf099c9c137d7d31c13"
	if job.Identity() != canonical {
		t.Fatalf("canonical identity changed: %s", job.Identity())
	}
	names := recoveryObjectNames(job)
	manifest, _, err := recoveryJobManifest(job, names.job, names.snapshot, "snapshot-uid")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var original kubernetesJobObservation
	if err := json.Unmarshal(payload, &original); err != nil {
		t.Fatal(err)
	}
	original.Metadata.UID = "job-uid"
	original.Status.Succeeded, original.Status.CompletionTime = 1, time.Unix(1, 0)
	for _, scenario := range []struct {
		name       string
		annotation string
		label      string
		allowed    bool
	}{
		{"generated", canonical, original.Metadata.Labels["raibitserver.io/spec-identity"], true},
		{"missing annotation", "", original.Metadata.Labels["raibitserver.io/spec-identity"], false},
		{"malformed annotation", "recovery-job/v1:sha256:bad", original.Metadata.Labels["raibitserver.io/spec-identity"], false},
		{"foreign annotation", "recovery-job/v1:sha256:" + strings.Repeat("0", 64), original.Metadata.Labels["raibitserver.io/spec-identity"], false},
		{"foreign matching pair", "recovery-job/v1:sha256:" + strings.Repeat("0", 64), "rj1-" + strings.Repeat("a", 52), false},
		{"mismatched label", canonical, "rj1-" + strings.Repeat("a", 52), false},
		{"legacy label", canonical, canonical, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			observed := original
			observed.Metadata.Annotations = map[string]string{"raibitserver.io/spec-identity": scenario.annotation}
			observed.Metadata.Labels = expectedJobLabels(job)
			observed.Metadata.Labels["raibitserver.io/spec-identity"] = scenario.label
			// When: completion is decoded and checked against the trusted job.
			completed, decodeErr := observed.completed()
			_, validationErr := validateCompletedJob(job, completed)
			// Then: only the exact annotation/label pair retains canonical receipt identity.
			if allowed := decodeErr == nil && validationErr == nil; allowed != scenario.allowed {
				t.Fatalf("allowed=%v decode=%v validation=%v", allowed, decodeErr, validationErr)
			}
			if scenario.allowed && (completed.SpecIdentity != canonical || original.Metadata.Annotations["raibitserver.io/spec-identity"] != canonical || !reflect.DeepEqual(job.Labels(), expectedJobLabels(job))) {
				t.Fatal("canonical annotation, completion identity or constructor labels changed")
			}
		})
	}
}
