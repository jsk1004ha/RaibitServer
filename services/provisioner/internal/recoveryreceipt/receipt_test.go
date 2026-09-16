package recoveryreceipt

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

const (
	testDecodedSHA = "4f58f9fddf1ee2f879f4f11ddc1e263a8902f5cc50c758d457a31f0f3f824c0b"
	testSchemaSHA  = "5194ba2f5d31bd5777e18c42ee66df3bed1c5ea49a64fb00c7440d7f69f43ed5"
	testDataSHA    = "b2f6f90dcbdeef529822283a9406b15e371d030c539a1ea581bfbb4e6c343995"
)

func validSpec(action Action, direction Direction) Spec {
	verification := VerificationSpec{Version: true, Schema: true, DecodedArtifact: true}
	if direction == DirectionRestore {
		verified := true
		verification.Sentinel = &verified
		if action == ActionRedisRestore || action == ActionValkeyRestore {
			verification.TTL = &verified
		}
	}
	return Spec{
		Engine:        action.Engine(),
		Action:        action,
		Direction:     direction,
		DecodedBytes:  128,
		DecodedSHA256: testDecodedSHA,
		Baseline:      &BaselineSpec{SchemaSHA256: testSchemaSHA, DataSHA256: testDataSHA, RecordCount: 7},
		Verification:  verification,
	}
}

func Test_Receipt_roundtrips_when_dump_is_verified(t *testing.T) {
	// Given
	receipt, err := New(validSpec(ActionPostgreSQLDump, DirectionDump))
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer

	// When
	err = Write(&encoded, receipt)
	parsed, parseErr := Parse(encoded.Bytes())

	// Then
	if err != nil || parseErr != nil {
		t.Fatalf("write=%v parse=%v", err, parseErr)
	}
	if parsed.DecodedBytes() != 128 || parsed.DecodedSHA256() != testDecodedSHA {
		t.Fatalf("decoded metadata was not preserved")
	}
	if err := parsed.ValidateFor(EnginePostgreSQL, ActionPostgreSQLDump, DirectionDump); err != nil {
		t.Fatalf("matching receipt rejected: %v", err)
	}
}

func Test_Receipt_roundtrips_when_cache_restore_is_fully_verified(t *testing.T) {
	// Given
	receipt, err := New(validSpec(ActionRedisRestore, DirectionRestore))
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer

	// When
	err = Write(&encoded, receipt)
	parsed, parseErr := Parse(encoded.Bytes())

	// Then
	if err != nil || parseErr != nil {
		t.Fatalf("write=%v parse=%v", err, parseErr)
	}
	if err := parsed.ValidateFor(EngineRedis, ActionRedisRestore, DirectionRestore); err != nil {
		t.Fatalf("matching receipt rejected: %v", err)
	}
}

func Test_Receipt_rejects_untrusted_JSON(t *testing.T) {
	valid := `{"wire_version":"raibit-recovery-receipt/v1","engine":"postgresql","action":"postgresql-dump","direction":"dump","decoded_bytes":128,"decoded_sha256":"` + testDecodedSHA + `","baseline":{"schema_sha256":"` + testSchemaSHA + `","data_sha256":"` + testDataSHA + `","record_count":7},"verification":{"version":true,"schema":true,"data":true}}`
	tests := []struct {
		name string
		raw  string
	}{
		{name: "truncated", raw: valid[:len(valid)-1]},
		{name: "unknown field", raw: strings.Replace(valid, `"wire_version"`, `"password":"hunter2","wire_version"`, 1)},
		{name: "duplicate field", raw: strings.Replace(valid, `"engine":"postgresql"`, `"engine":"postgresql","engine":"mysql"`, 1)},
		{name: "wrong action for engine", raw: strings.Replace(valid, `"postgresql-dump"`, `"mysql-dump"`, 1)},
		{name: "zero digest", raw: strings.Replace(valid, testDecodedSHA, strings.Repeat("0", 64), 1)},
		{name: "partial baseline", raw: strings.Replace(valid, `,"data_sha256":"`+testDataSHA+`"`, "", 1)},
		{name: "failed verification", raw: strings.Replace(valid, `"data":true`, `"data":false`, 1)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, err := Parse([]byte(test.raw))

			// Then
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_Receipt_rejects_oversized_message(t *testing.T) {
	// Given
	raw := []byte(strings.Repeat("x", MaxBytes+1))

	// When
	_, err := Parse(raw)

	// Then
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Receipt_rejects_decoded_bytes_above_recovery_wire_limit(t *testing.T) {
	// Given
	spec := validSpec(ActionPostgreSQLDump, DirectionDump)
	spec.DecodedBytes = recoverywire.DefaultLimits().MaxBytes() + 1

	// When
	_, err := New(spec)

	// Then
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Receipt_rejects_missing_action_specific_verification(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Spec)
	}{
		{name: "restore sentinel", mutate: func(spec *Spec) { spec.Verification.Sentinel = nil }},
		{name: "cache restore ttl", mutate: func(spec *Spec) { spec.Verification.TTL = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Given
			spec := validSpec(ActionRedisRestore, DirectionRestore)
			test.mutate(&spec)

			// When
			_, err := New(spec)

			// Then
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_Receipt_rejects_mismatched_expectation_without_leaking_values(t *testing.T) {
	// Given
	receipt, err := New(validSpec(ActionMongoDBRestore, DirectionRestore))
	if err != nil {
		t.Fatal(err)
	}

	// When
	err = receipt.ValidateFor(EnginePostgreSQL, ActionPostgreSQLRestore, DirectionRestore)

	// Then
	if !errors.Is(err, ErrInvalid) || strings.Contains(err.Error(), "mongodb") {
		t.Fatalf("unsanitized error=%v", err)
	}
}
