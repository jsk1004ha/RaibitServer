package provider

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

// Generated copy of test-fixtures/contracts/resource-capabilities-v1.json.
// Run node scripts/generate-resource-capabilities.mjs after changing the source.
//
//go:embed resource-capabilities-v1.json
var capabilityJSON []byte

type capabilityOperations struct {
	Provision           bool `json:"provision"`
	AuthenticatedHealth bool `json:"authenticatedHealth"`
	Attach              bool `json:"attach"`
	Query               bool `json:"query"`
	Schema              bool `json:"schema"`
	Backup              bool `json:"backup"`
	Restore             bool `json:"restore"`
}

type resourceCapability struct {
	Engine     string               `json:"engine"`
	Runtime    string               `json:"runtime"`
	ImageKey   string               `json:"imageKey"`
	ReasonCode string               `json:"reasonCode"`
	Local      capabilityOperations `json:"local"`
	Release    capabilityOperations `json:"release"`
}

var loadCapabilities = sync.OnceValues(func() ([]resourceCapability, error) {
	var contract struct {
		Engines []resourceCapability `json:"engines"`
	}
	if err := json.Unmarshal(capabilityJSON, &contract); err != nil {
		return nil, fmt.Errorf("decode resource capability contract: %w", err)
	}
	return contract.Engines, nil
})

func CapabilityHash() string { return fmt.Sprintf("%x", sha256.Sum256(capabilityJSON)) }

type CapabilityUnavailableError struct {
	Engine     string
	ReasonCode string
}

func (e *CapabilityUnavailableError) Error() string {
	return fmt.Sprintf("RESOURCE_CAPABILITY_UNAVAILABLE: %s: %s", e.Engine, e.ReasonCode)
}

func requireLocalCapability(engine string) error {
	entries, err := loadCapabilities()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Engine != engine {
			continue
		}
		if entry.Runtime == "dedicated-local" && entry.Local.Provision && entry.Local.AuthenticatedHealth {
			return nil
		}
		return &CapabilityUnavailableError{Engine: engine, ReasonCode: entry.ReasonCode}
	}
	return &CapabilityUnavailableError{Engine: engine, ReasonCode: "ENGINE_NOT_IMPLEMENTED"}
}
