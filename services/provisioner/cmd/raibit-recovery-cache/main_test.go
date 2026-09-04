package main

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoverycache"
)

func Test_parseArguments_accepts_only_one_fixed_action(t *testing.T) {
	for _, args := range [][]string{
		{"redis-backup"}, {"redis-restore"}, {"redis-verify"},
		{"valkey-backup"}, {"valkey-restore"}, {"valkey-verify"},
	} {
		// When
		action, err := recoverycache.ParseAction(args)

		// Then
		if err != nil || action.String() != args[0] {
			t.Fatalf("ParseAction(%q) = %q, %v", args, action.String(), err)
		}
	}
	for _, args := range [][]string{{}, {"redis-backup", "extra"}, {"sh"}} {
		// When
		_, err := recoverycache.ParseAction(args)

		// Then
		if !errors.Is(err, recoverycache.ErrAction) {
			t.Fatalf("ParseAction(%q) error = %v", args, err)
		}
	}
}

func Test_Dockerfile_enforces_digest_tools_and_nonroot_runtime(t *testing.T) {
	// Given
	content, err := os.ReadFile("../../recovery-images/cache/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(content)
	wants := []string{
		`case "$GO_BUILD_IMAGE" in *@sha256:*`,
		`case "$BASE_IMAGE" in *@sha256:*`,
		`command -v "$binary"`,
		`redis-cli --help`,
		`valkey-cli --help`,
		`redis-cli --version`,
		`valkey-cli --version`,
		`redis-server --version`,
		`valkey-server --version`,
		`USER 65532:65532`,
		`rootfs="read-only-required"`,
	}

	// When / Then
	for _, want := range wants {
		if !strings.Contains(dockerfile, want) {
			t.Fatalf("Dockerfile missing enforced contract %q", want)
		}
	}
}

func Test_imageContract_matches_binary_ABI(t *testing.T) {
	// Given
	content, err := os.ReadFile("../../recovery-images/cache/contract.json")
	if err != nil {
		t.Fatalf("read image contract: %v", err)
	}
	var contract struct {
		Version          int      `json:"version"`
		Entrypoint       string   `json:"entrypoint"`
		Actions          []string `json:"actions"`
		CredentialPath   string   `json:"credentialPath"`
		ScratchPath      string   `json:"scratchPath"`
		BaseImagePolicy  string   `json:"baseImagePolicy"`
		RunAsUser        int64    `json:"runAsUser"`
		ReadOnlyRoot     bool     `json:"readOnlyRootFilesystem"`
		MaxRDBBytes      int64    `json:"maxRDBBytes"`
		MaxSourceMemory  int64    `json:"maxSourceMemoryBytes"`
		RequiredBinaries []string `json:"requiredBinaries"`
	}
	if err := json.Unmarshal(content, &contract); err != nil {
		t.Fatalf("decode image contract: %v", err)
	}

	// When
	wantActions := []string{"redis-backup", "redis-restore", "redis-verify", "valkey-backup", "valkey-restore", "valkey-verify"}

	// Then
	if contract.Version != 1 || contract.Entrypoint != "/usr/local/bin/raibit-recovery-cache" || !reflect.DeepEqual(contract.Actions, wantActions) || contract.CredentialPath != recoverycache.CredentialPath || contract.ScratchPath != recoverycache.ScratchPath || contract.BaseImagePolicy != "sha256-digest-required" || contract.RunAsUser != 65532 || !contract.ReadOnlyRoot || contract.MaxRDBBytes != recoverycache.MaxRDBBytes || contract.MaxSourceMemory != recoverycache.MaxSourceMemoryBytes || len(contract.RequiredBinaries) != 6 {
		t.Fatalf("image contract does not match fixed ABI: %+v", contract)
	}
}
