package recoverycache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
)

func Test_TTLSidecar_natural_countdown_round_trips_and_verifies(t *testing.T) {
	// Given
	deadline := int64(1_800_000_010_000)
	source := newFakeCache(map[string]keySnapshot{
		"persistent": {kind: "string", dump: []byte("dump-a"), pttl: -1},
		"temporary":  {kind: "list", dump: []byte("dump-b"), pttl: 10_000},
	})
	source.serverTimeValue = deadline - 10_000
	source.expiryTimes = map[string]int64{"temporary": deadline}
	records, err := captureTTLRecords(t.Context(), source, [][]byte{[]byte("persistent"), []byte("temporary")})
	if err != nil {
		t.Fatal(err)
	}
	payload, descriptor, err := encodeTTLRecords(records)
	if err != nil {
		t.Fatal(err)
	}
	target := newFakeCache(map[string]keySnapshot{
		"persistent": {kind: "string", dump: []byte("dump-a"), pttl: -1},
		"temporary":  {kind: "list", dump: []byte("dump-b"), pttl: 8_000},
	})
	target.serverTimeValue = deadline - 8_000
	target.expiryTimes = map[string]int64{"temporary": deadline}

	// When
	decoded, decodeErr := decodeTTLRecords(bytes.NewReader(payload), descriptor)
	verifyErr := verifyTTLRecords(t.Context(), target, decoded, 2)

	// Then
	if decodeErr != nil || verifyErr != nil {
		t.Fatalf("decode=%v verify=%v", decodeErr, verifyErr)
	}
}

func Test_TTLSidecar_rejects_value_type_deadline_state_and_extra_drift(t *testing.T) {
	// Given
	deadline := int64(1_800_000_010_000)
	records := []ttlRecord{
		{key: []byte("persistent"), valueSHA: ttlValueDigest(keySnapshot{kind: "string", dump: []byte("a"), pttl: -1}), kind: ttlPersistent},
		{key: []byte("temporary"), valueSHA: ttlValueDigest(keySnapshot{kind: "list", dump: []byte("b"), pttl: 10_000}), kind: ttlExpiring, deadline: deadline},
	}
	tests := []struct {
		name   string
		values map[string]keySnapshot
		expiry map[string]int64
		now    int64
	}{
		{name: "ten seconds became ten hours", values: map[string]keySnapshot{"persistent": {kind: "string", dump: []byte("a"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: 36_000_000}}, expiry: map[string]int64{"temporary": deadline + 35_990_000}, now: deadline - 10_000},
		{name: "deadline drift", values: map[string]keySnapshot{"persistent": {kind: "string", dump: []byte("a"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: 9_999}}, expiry: map[string]int64{"temporary": deadline - 1}, now: deadline - 10_000},
		{name: "persistent became expiring", values: map[string]keySnapshot{"persistent": {kind: "string", dump: []byte("a"), pttl: 5_000}, "temporary": {kind: "list", dump: []byte("b"), pttl: 10_000}}, expiry: map[string]int64{"persistent": deadline - 5_000, "temporary": deadline}, now: deadline - 10_000},
		{name: "value drift", values: map[string]keySnapshot{"persistent": {kind: "string", dump: []byte("changed"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: 10_000}}, expiry: map[string]int64{"temporary": deadline}, now: deadline - 10_000},
		{name: "type drift", values: map[string]keySnapshot{"persistent": {kind: "set", dump: []byte("a"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: 10_000}}, expiry: map[string]int64{"temporary": deadline}, now: deadline - 10_000},
		{name: "extra key", values: map[string]keySnapshot{"extra": {kind: "string", dump: []byte("x"), pttl: -1}, "persistent": {kind: "string", dump: []byte("a"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: 10_000}}, expiry: map[string]int64{"temporary": deadline}, now: deadline - 10_000},
		{name: "resurrected expired key", values: map[string]keySnapshot{"persistent": {kind: "string", dump: []byte("a"), pttl: -1}, "temporary": {kind: "list", dump: []byte("b"), pttl: -1}}, now: deadline + 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := newFakeCache(test.values)
			target.serverTimeValue = test.now
			target.expiryTimes = test.expiry

			// When
			err := verifyTTLRecords(t.Context(), target, records, 2)

			// Then
			if !errors.Is(err, ErrOperation) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_TTLSidecar_allows_only_expired_missing_keys_at_server_time(t *testing.T) {
	// Given
	deadline := int64(1_800_000_010_000)
	record := ttlRecord{key: []byte("temporary"), valueSHA: ttlValueDigest(keySnapshot{kind: "string", dump: []byte("a"), pttl: 1}), kind: ttlExpiring, deadline: deadline}

	// When
	expired := newFakeCache(nil)
	expired.serverTimeValue = deadline
	expiredErr := verifyTTLRecords(t.Context(), expired, []ttlRecord{record}, 1)
	notExpired := newFakeCache(nil)
	notExpired.serverTimeValue = deadline - 1
	notExpiredErr := verifyTTLRecords(t.Context(), notExpired, []ttlRecord{record}, 1)

	// Then
	if expiredErr != nil || !errors.Is(notExpiredErr, ErrOperation) {
		t.Fatalf("expired=%v notExpired=%v", expiredErr, notExpiredErr)
	}
}

func Test_TTLSidecar_rejects_malformed_unsorted_truncated_oversized_and_wrong_digest(t *testing.T) {
	// Given
	records := []ttlRecord{
		{key: []byte("a"), valueSHA: sha256.Sum256([]byte("a")), kind: ttlPersistent},
		{key: []byte("b"), valueSHA: sha256.Sum256([]byte("b")), kind: ttlPersistent},
	}
	payload, descriptor, err := encodeTTLRecords(records)
	if err != nil {
		t.Fatal(err)
	}
	unsorted := bytes.Clone(payload)
	secondKeyOffset := 12 + 4 + 1 + sha256.Size + 1 + 8 + 4
	unsorted[secondKeyOffset] = 'a'
	unsortedDescriptor := ttlDescriptor{bytes: uint64(len(unsorted)), sha256: sha256.Sum256(unsorted)}
	wantWrong := descriptor
	wantWrong.sha256 = sha256.Sum256([]byte("wrong"))
	tests := []struct {
		name       string
		payload    []byte
		descriptor ttlDescriptor
	}{
		{name: "wrong digest", payload: payload, descriptor: wantWrong},
		{name: "truncated", payload: payload[:len(payload)-1], descriptor: descriptor},
		{name: "oversized", payload: payload, descriptor: ttlDescriptor{bytes: maxTTLSidecarBytes + 1, sha256: descriptor.sha256}},
		{name: "duplicate or unsorted", payload: unsorted, descriptor: unsortedDescriptor},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// When
			_, err := decodeTTLRecords(bytes.NewReader(test.payload), test.descriptor)

			// Then
			if !errors.Is(err, ErrOperation) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func Test_TTLSidecar_fails_closed_on_server_clock_or_expiry_errors(t *testing.T) {
	// Given
	cache := newFakeCache(map[string]keySnapshot{"a": {kind: "string", dump: []byte("a"), pttl: 10_000}})
	cache.serverTimeErr = errors.New("bad TIME")

	// When
	_, timeErr := captureTTLRecords(context.Background(), cache, [][]byte{[]byte("a")})
	cache.serverTimeErr = nil
	cache.expireTimeErr = errors.New("bad PEXPIRETIME")
	_, expiryErr := captureTTLRecords(context.Background(), cache, [][]byte{[]byte("a")})

	// Then
	if !errors.Is(timeErr, ErrOperation) || !errors.Is(expiryErr, ErrOperation) {
		t.Fatalf("time=%v expiry=%v", timeErr, expiryErr)
	}
}
