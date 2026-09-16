package recoverycache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"io"
)

const (
	ttlSidecarMagic    = "RBTCTTL1"
	maxTTLSidecarBytes = 64 << 20
	maxTTLKeyBytes     = 1 << 20
	ttlPersistent      = byte(0)
	ttlExpiring        = byte(1)
)

type ttlRecord struct {
	key      []byte
	valueSHA [sha256.Size]byte
	kind     byte
	deadline int64
}

type ttlDescriptor struct {
	bytes  uint64
	sha256 [sha256.Size]byte
}

func captureTTLRecords(ctx context.Context, client cacheClient, keys [][]byte) ([]ttlRecord, error) {
	now, err := client.serverTime(ctx)
	if err != nil || now < 0 {
		return nil, safeStep("read server time", ErrOperation)
	}
	records := make([]ttlRecord, len(keys))
	for index, key := range keys {
		if len(key) == 0 || len(key) > maxTTLKeyBytes || index > 0 && bytes.Compare(keys[index-1], key) >= 0 {
			return nil, ErrLimit
		}
		snapshot, err := client.snapshot(ctx, key)
		if err != nil {
			return nil, safeStep("capture TTL value", ErrOperation)
		}
		deadline, err := client.expireTime(ctx, key)
		if err != nil || deadline == -2 {
			return nil, safeStep("capture expiry deadline", ErrOperation)
		}
		kind := ttlPersistent
		if deadline == -1 {
			if snapshot.pttl != -1 {
				return nil, safeStep("capture expiry kind", ErrOperation)
			}
			deadline = 0
		} else {
			if deadline <= now || snapshot.pttl <= 0 {
				return nil, safeStep("capture expiry deadline", ErrOperation)
			}
			kind = ttlExpiring
		}
		records[index] = ttlRecord{key: bytes.Clone(key), valueSHA: ttlValueDigest(snapshot), kind: kind, deadline: deadline}
	}
	return records, nil
}

func ttlValueDigest(snapshot keySnapshot) [sha256.Size]byte {
	buffer := make([]byte, 0, len(snapshot.kind)+1+len(snapshot.dump))
	buffer = append(buffer, snapshot.kind...)
	buffer = append(buffer, 0)
	buffer = append(buffer, snapshot.dump...)
	return sha256.Sum256(buffer)
}

func encodeTTLRecords(records []ttlRecord) ([]byte, ttlDescriptor, error) {
	if len(records) > maxScannedKeys {
		return nil, ttlDescriptor{}, ErrLimit
	}
	var output bytes.Buffer
	output.Grow(min(maxTTLSidecarBytes, len(records)*64+12))
	output.WriteString(ttlSidecarMagic)
	if err := binary.Write(&output, binary.BigEndian, uint32(len(records))); err != nil {
		return nil, ttlDescriptor{}, ErrOperation
	}
	for index, record := range records {
		if len(record.key) == 0 || len(record.key) > maxTTLKeyBytes || index > 0 && bytes.Compare(records[index-1].key, record.key) >= 0 || record.valueSHA == [sha256.Size]byte{} || record.kind > ttlExpiring || record.kind == ttlPersistent && record.deadline != 0 || record.kind == ttlExpiring && record.deadline <= 0 {
			return nil, ttlDescriptor{}, ErrOperation
		}
		entrySize := 4 + len(record.key) + sha256.Size + 1 + 8
		if output.Len() > maxTTLSidecarBytes-entrySize {
			return nil, ttlDescriptor{}, ErrLimit
		}
		if err := binary.Write(&output, binary.BigEndian, uint32(len(record.key))); err != nil {
			return nil, ttlDescriptor{}, ErrOperation
		}
		output.Write(record.key)
		output.Write(record.valueSHA[:])
		output.WriteByte(record.kind)
		if err := binary.Write(&output, binary.BigEndian, record.deadline); err != nil {
			return nil, ttlDescriptor{}, ErrOperation
		}
	}
	payload := output.Bytes()
	descriptor := ttlDescriptor{bytes: uint64(len(payload)), sha256: sha256.Sum256(payload)}
	return bytes.Clone(payload), descriptor, nil
}

func decodeTTLRecords(input io.Reader, descriptor ttlDescriptor) ([]ttlRecord, error) {
	if input == nil || descriptor.bytes < 12 || descriptor.bytes > maxTTLSidecarBytes || descriptor.sha256 == [sha256.Size]byte{} {
		return nil, ErrOperation
	}
	payload, err := io.ReadAll(io.LimitReader(input, int64(descriptor.bytes)+1))
	if err != nil || uint64(len(payload)) != descriptor.bytes || sha256.Sum256(payload) != descriptor.sha256 {
		return nil, ErrOperation
	}
	return parseTTLRecords(payload)
}

func decodeAuthenticatedTTLRecords(input io.Reader) ([]ttlRecord, error) {
	if input == nil {
		return nil, ErrOperation
	}
	payload, err := io.ReadAll(io.LimitReader(input, maxTTLSidecarBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxTTLSidecarBytes {
		return nil, ErrOperation
	}
	return parseTTLRecords(payload)
}

func parseTTLRecords(payload []byte) ([]ttlRecord, error) {
	reader := bytes.NewReader(payload)
	magic := make([]byte, len(ttlSidecarMagic))
	if _, err := io.ReadFull(reader, magic); err != nil || string(magic) != ttlSidecarMagic {
		return nil, ErrOperation
	}
	var count uint32
	if err := binary.Read(reader, binary.BigEndian, &count); err != nil || count > maxScannedKeys {
		return nil, ErrOperation
	}
	records := make([]ttlRecord, int(count))
	for index := range records {
		var keyLength uint32
		if err := binary.Read(reader, binary.BigEndian, &keyLength); err != nil || keyLength == 0 || keyLength > maxTTLKeyBytes || uint64(keyLength) > uint64(reader.Len()) {
			return nil, ErrOperation
		}
		record := ttlRecord{key: make([]byte, int(keyLength))}
		if _, err := io.ReadFull(reader, record.key); err != nil {
			return nil, ErrOperation
		}
		if _, err := io.ReadFull(reader, record.valueSHA[:]); err != nil || record.valueSHA == [sha256.Size]byte{} {
			return nil, ErrOperation
		}
		kind, err := reader.ReadByte()
		if err != nil {
			return nil, ErrOperation
		}
		record.kind = kind
		if err := binary.Read(reader, binary.BigEndian, &record.deadline); err != nil || record.kind > ttlExpiring || record.kind == ttlPersistent && record.deadline != 0 || record.kind == ttlExpiring && record.deadline <= 0 || index > 0 && bytes.Compare(records[index-1].key, record.key) >= 0 {
			return nil, ErrOperation
		}
		records[index] = record
	}
	if reader.Len() != 0 {
		return nil, ErrOperation
	}
	return records, nil
}

func verifyTTLRecords(ctx context.Context, target cacheClient, records []ttlRecord, expectedCount int64) error {
	if expectedCount < 0 || int64(len(records)) != expectedCount {
		return safeStep("verify TTL record count", ErrOperation)
	}
	keys, err := scanAll(ctx, target, 64)
	if err != nil {
		return err
	}
	now, err := target.serverTime(ctx)
	if err != nil || now < 0 {
		return safeStep("read final server time", ErrOperation)
	}
	keyIndex := 0
	for _, record := range records {
		for keyIndex < len(keys) && bytes.Compare(keys[keyIndex], record.key) < 0 {
			return safeStep("reject extra restored key", ErrOperation)
		}
		if keyIndex >= len(keys) || !bytes.Equal(keys[keyIndex], record.key) {
			if record.kind == ttlExpiring && now >= record.deadline {
				continue
			}
			return safeStep("reject missing restored key", ErrOperation)
		}
		snapshot, err := target.snapshot(ctx, record.key)
		if err != nil || ttlValueDigest(snapshot) != record.valueSHA {
			return safeStep("verify restored value", ErrOperation)
		}
		deadline, err := target.expireTime(ctx, record.key)
		if err != nil {
			return safeStep("verify restored expiry", ErrOperation)
		}
		if record.kind == ttlPersistent && deadline != -1 || record.kind == ttlExpiring && (deadline != record.deadline || deadline <= now) {
			return safeStep("verify restored expiry", ErrOperation)
		}
		keyIndex++
	}
	if keyIndex != len(keys) {
		return safeStep("reject extra restored key", ErrOperation)
	}
	return nil
}
