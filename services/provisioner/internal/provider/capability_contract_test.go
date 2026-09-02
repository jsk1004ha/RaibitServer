package provider

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/raibitserver/provisioner/internal/store"
)

func TestCapabilityContract(t *testing.T) {
	// Given the canonical source and the embedded generated Go projection.
	source, err := os.ReadFile("../../../../test-fixtures/contracts/resource-capabilities-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(source, capabilityJSON) {
		t.Fatal("Go: resource capability drift")
	}
	if CapabilityHash() != fmt.Sprintf("%x", sha256.Sum256(source)) {
		t.Fatal("Go: capability hash mismatch")
	}
	t.Logf("RESOURCE_CAPABILITY_SHA256=%s", CapabilityHash())
	entries, err := loadCapabilities()
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		t.Run(entry.Engine, func(t *testing.T) {
			// When the actual provider compiler receives each catalog engine.
			plan, err := Compile(&store.Resource{ID: "capability", ProjectID: "capability-project", OrganizationID: "capability-org", ProjectSlug: "capability", Name: "db", Engine: entry.Engine}, "registry.example/provider@"+testDigest)
			// Then only authenticated dedicated-local engines produce workloads.
			if entry.Runtime == "dedicated-local" && entry.Local.Provision {
				if err != nil {
					t.Fatal(err)
				}
				if len(plan.ProbeCommand) == 0 || len(plan.PublicManifests) != 5 {
					t.Fatal("Go: incomplete authenticated provider contract")
				}
			} else {
				if plan != nil || err == nil {
					t.Fatal("Go: unsupported engine generated a workload")
				}
				if entry.Engine != "sqlite" {
					var unavailable *CapabilityUnavailableError
					if !errors.As(err, &unavailable) {
						t.Fatalf("Go: expected typed capability rejection: %v", err)
					}
				}
			}
			if entry.Local.Backup || entry.Local.Restore || entry.Release.Provision {
				t.Fatal("Go: unavailable workflow/release advertised as implemented")
			}
		})
	}
}
