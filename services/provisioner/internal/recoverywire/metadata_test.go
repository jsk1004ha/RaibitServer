package recoverywire

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
)

func Test_NewMetadata_accepts_supported_engine_format_pairs(t *testing.T) {
	tests := []struct {
		engine Engine
		format Format
	}{
		{EnginePostgreSQL, FormatPGCustom},
		{EngineMySQL, FormatSQL},
		{EngineMariaDB, FormatSQL},
		{EngineMongoDB, FormatMongoArchiveGzip},
		{EngineRedis, FormatRDB},
		{EngineValkey, FormatRDB},
	}
	for _, test := range tests {
		t.Run(string(test.engine), func(t *testing.T) {
			// When
			metadata, err := NewMetadata(test.engine, "8.0.36-enterprise", test.format)

			// Then
			if err != nil {
				t.Fatal(err)
			}
			if metadata.Engine() != test.engine || metadata.Version() != "8.0.36-enterprise" || metadata.Format() != test.format {
				t.Fatal("metadata accessors mismatch")
			}
		})
	}
}

func Test_Decoder_rejects_noncanonical_or_partial_baseline_fields(t *testing.T) {
	// Given
	schemaDigest := sha256.Sum256([]byte("schema"))
	dataDigest := sha256.Sum256([]byte("data"))
	canonical := "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom schema-sha256=" + fmtDigest(schemaDigest) +
		" data-sha256=" + fmtDigest(dataDigest) + " records=7\n"
	tests := []struct {
		name   string
		header string
	}{
		{"swapped keys", "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom data-sha256=" + fmtDigest(dataDigest) + " schema-sha256=" + fmtDigest(schemaDigest) + " records=7\n"},
		{"missing record count", strings.Replace(canonical, " records=7", "", 1)},
		{"uppercase digest", strings.Replace(canonical, fmtDigest(schemaDigest), strings.ToUpper(fmtDigest(schemaDigest)), 1)},
		{"noncanonical record count", strings.Replace(canonical, "records=7", "records=07", 1)},
		{"none with extra field", "RAIBIT-RECOVERY/1 postgresql 16.4 pg-custom baseline=none records=0\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, err := NewDecoder(DefaultLimits()).Decode(context.Background(), io.Discard, strings.NewReader(test.header))

			// Then
			if !errors.Is(err, ErrInvalidEnvelope) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func fmtDigest(digest [sha256.Size]byte) string {
	return hex.EncodeToString(digest[:])
}

func Test_NewBaseline_rejects_zero_digests(t *testing.T) {
	// Given
	validDigest := sha256.Sum256([]byte("valid"))

	// When
	_, missingSchemaErr := NewBaseline([sha256.Size]byte{}, validDigest, 1)
	_, missingDataErr := NewBaseline(validDigest, [sha256.Size]byte{}, 1)

	// Then
	if !errors.Is(missingSchemaErr, ErrInvalidMetadata) || !errors.Is(missingDataErr, ErrInvalidMetadata) {
		t.Fatalf("schema=%v data=%v", missingSchemaErr, missingDataErr)
	}
}

func Test_NewMetadata_rejects_unknown_or_injected_values(t *testing.T) {
	tests := []struct {
		name    string
		engine  Engine
		version string
		format  Format
	}{
		{"unknown engine", "oracle", "19", FormatSQL},
		{"mismatched format", EngineRedis, "7.2", FormatSQL},
		{"newline version", EnginePostgreSQL, "16\nD 0000000000", FormatPGCustom},
		{"space version", EnginePostgreSQL, "16 latest", FormatPGCustom},
		{"empty version", EnginePostgreSQL, "", FormatPGCustom},
		{"oversized version", EnginePostgreSQL, "123456789012345678901234567890123", FormatPGCustom},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, err := NewMetadata(test.engine, test.version, test.format)

			// Then
			if !errors.Is(err, ErrInvalidMetadata) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}
