package recoverycache

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

const (
	CredentialPath = "/var/run/raibit-recovery/credential"
	ScratchPath    = "/var/run/raibit-recovery/scratch"

	restoreRDBName       = "restore.rdb"
	backupRDBName        = "backup.rdb"
	maxCredential        = 4096
	MaxRDBBytes          = int64(512 << 20)
	MaxSourceMemoryBytes = int64(1 << 30)
	maxArtifact          = MaxRDBBytes
	sentinelPrefix       = "__raibit_recovery_sentinel__"
)

var safeEndpointPart = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`)

type config struct {
	host             string
	port             uint16
	username         string
	index            uint16
	credentialPath   string
	scratchPath      string
	maxArtifactBytes int64
	batchSize        int
	migrationTimeout time.Duration
	operationTimeout time.Duration
	pollInterval     time.Duration
	ttlTolerance     time.Duration
}

func loadConfig(getenv func(string) string) (config, error) {
	port, err := parseUint16(getenv("RAIBIT_RECOVERY_PORT"), false)
	if err != nil {
		return config{}, ErrConfig
	}
	index, err := parseUint16(getenv("RAIBIT_RECOVERY_INDEX"), true)
	if err != nil {
		return config{}, ErrConfig
	}
	host := getenv("RAIBIT_RECOVERY_HOST")
	username := getenv("RAIBIT_RECOVERY_USERNAME")
	if !safeEndpointPart.MatchString(host) || !safeEndpointPart.MatchString(username) {
		return config{}, ErrConfig
	}
	return config{
		host:             host,
		port:             port,
		username:         username,
		index:            index,
		credentialPath:   CredentialPath,
		scratchPath:      ScratchPath,
		maxArtifactBytes: maxArtifact,
		batchSize:        64,
		migrationTimeout: 5 * time.Second,
		operationTimeout: 20 * time.Minute,
		pollInterval:     250 * time.Millisecond,
		ttlTolerance:     5 * time.Second,
	}, nil
}

func parseUint16(raw string, allowEmpty bool) (uint16, error) {
	if raw == "" && allowEmpty {
		return 0, nil
	}
	value, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || (!allowEmpty && value == 0) {
		return 0, ErrConfig
	}
	return uint16(value), nil
}

func (c config) validate() error {
	if !safeEndpointPart.MatchString(c.host) || !safeEndpointPart.MatchString(c.username) || c.port == 0 || c.credentialPath == "" || c.scratchPath == "" || c.maxArtifactBytes < 1 || c.maxArtifactBytes > maxArtifact || c.batchSize < 1 || c.batchSize > 512 || c.migrationTimeout <= 0 || c.operationTimeout <= 0 || c.pollInterval <= 0 || c.ttlTolerance < 0 {
		return ErrConfig
	}
	return nil
}

func (c config) readCredential() ([]byte, error) {
	file, err := os.Open(filepath.Clean(c.credentialPath))
	if err != nil {
		return nil, ErrConfig
	}
	credential, readErr := io.ReadAll(io.LimitReader(file, maxCredential+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, ErrConfig
	}
	if len(credential) == 0 || len(credential) > maxCredential || bytes.IndexByte(credential, 0) >= 0 {
		return nil, ErrConfig
	}
	return bytes.Clone(credential), nil
}

func safeStep(step string, target error) error {
	return fmt.Errorf("recovery cache %s: %w", step, target)
}
