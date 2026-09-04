package recoverycache

import (
	"bytes"
	"context"
	"strconv"
	"strings"
	"time"
)

func (c *respClient) ping(ctx context.Context) error {
	value, err := c.command(ctx, []byte("PING"))
	if err != nil || value.kind != replySimple || !bytes.Equal(value.data, []byte("PONG")) {
		return ErrOperation
	}
	return nil
}

func (c *respClient) bgSave(ctx context.Context) error {
	value, err := c.command(ctx, []byte("BGSAVE"))
	if err != nil || value.kind != replySimple {
		return ErrOperation
	}
	return nil
}

func (c *respClient) lastSave(ctx context.Context) (int64, error) {
	value, err := c.command(ctx, []byte("LASTSAVE"))
	if err != nil || value.kind != replyInteger || value.integer < 0 {
		return 0, ErrOperation
	}
	return value.integer, nil
}

func (c *respClient) dbSize(ctx context.Context) (int64, error) {
	value, err := c.command(ctx, []byte("DBSIZE"))
	if err != nil || value.kind != replyInteger || value.integer < 0 {
		return 0, ErrOperation
	}
	return value.integer, nil
}

func (c *respClient) usedMemory(ctx context.Context) (int64, error) {
	value, err := c.command(ctx, []byte("INFO"), []byte("MEMORY"))
	if err != nil || value.kind != replyBulk {
		return 0, ErrOperation
	}
	for _, line := range strings.Split(string(value.data), "\r\n") {
		if raw, ok := strings.CutPrefix(line, "used_memory:"); ok {
			used, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || used < 0 {
				return 0, ErrOperation
			}
			return used, nil
		}
	}
	return 0, ErrOperation
}

func (c *respClient) ready(ctx context.Context) error {
	value, err := c.command(ctx, []byte("INFO"), []byte("PERSISTENCE"))
	if err != nil || value.kind != replyBulk {
		return ErrOperation
	}
	loading := false
	loaded := false
	for _, line := range strings.Split(string(value.data), "\r\n") {
		switch line {
		case "loading:0":
			loading = true
		case "rdb_last_bgsave_status:ok":
			loaded = true
		}
	}
	if !loading || !loaded {
		return ErrOperation
	}
	return nil
}

func (c *respClient) databaseIndexes(ctx context.Context) ([]uint16, error) {
	value, err := c.command(ctx, []byte("INFO"), []byte("KEYSPACE"))
	if err != nil || value.kind != replyBulk {
		return nil, ErrOperation
	}
	var indexes []uint16
	for _, line := range strings.Split(string(value.data), "\r\n") {
		if !strings.HasPrefix(line, "db") {
			continue
		}
		label, details, found := strings.Cut(line, ":")
		if !found || !strings.HasPrefix(details, "keys=") {
			return nil, ErrOperation
		}
		index, parseErr := strconv.ParseUint(strings.TrimPrefix(label, "db"), 10, 16)
		keysRaw, _, found := strings.Cut(strings.TrimPrefix(details, "keys="), ",")
		keys, keysErr := strconv.ParseUint(keysRaw, 10, 64)
		if parseErr != nil || keysErr != nil || !found {
			return nil, ErrOperation
		}
		if keys > 0 {
			indexes = append(indexes, uint16(index))
		}
	}
	return indexes, nil
}

func (c *respClient) version(ctx context.Context, expected engine) (string, error) {
	value, err := c.command(ctx, []byte("INFO"), []byte("SERVER"))
	if err != nil || value.kind != replyBulk {
		return "", ErrOperation
	}
	prefix := ""
	switch expected {
	case engineRedis:
		prefix = "redis_version:"
	case engineValkey:
		prefix = "valkey_version:"
	default:
		return "", ErrCapability
	}
	for _, line := range strings.Split(string(value.data), "\r\n") {
		if version, ok := strings.CutPrefix(line, prefix); ok && version != "" && len(version) <= 64 {
			return version, nil
		}
	}
	return "", ErrOperation
}

func (c *respClient) set(ctx context.Context, key, value []byte, ttl time.Duration, nx bool) error {
	arguments := [][]byte{[]byte("SET"), key, value, []byte("PX"), []byte(strconv.FormatInt(ttl.Milliseconds(), 10))}
	if nx {
		arguments = append(arguments, []byte("NX"))
	}
	reply, err := c.command(ctx, arguments...)
	if err != nil || reply.kind != replySimple || !bytes.Equal(reply.data, []byte("OK")) {
		return ErrOperation
	}
	return nil
}

func (c *respClient) get(ctx context.Context, key []byte) ([]byte, error) {
	value, err := c.command(ctx, []byte("GET"), key)
	if err != nil || value.kind != replyBulk || value.data == nil {
		return nil, ErrOperation
	}
	return bytes.Clone(value.data), nil
}
