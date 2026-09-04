package recoverycache

import (
	"bytes"
	"context"
	"strconv"
	"time"
)

func (c *respClient) scan(ctx context.Context, cursor string, count int) (string, [][]byte, error) {
	value, err := c.command(ctx, []byte("SCAN"), []byte(cursor), []byte("COUNT"), []byte(strconv.Itoa(count)))
	if err != nil || value.kind != replyArray || len(value.array) != 2 || value.array[0].kind != replyBulk || value.array[1].kind != replyArray {
		return "", nil, ErrOperation
	}
	next := string(value.array[0].data)
	if _, err := strconv.ParseUint(next, 10, 64); err != nil {
		return "", nil, ErrOperation
	}
	keys := make([][]byte, len(value.array[1].array))
	for index, item := range value.array[1].array {
		if item.kind != replyBulk || item.data == nil {
			return "", nil, ErrOperation
		}
		keys[index] = bytes.Clone(item.data)
	}
	return next, keys, nil
}

func (c *respClient) migrate(ctx context.Context, target config, credential []byte, keys [][]byte, timeout time.Duration) error {
	if len(keys) == 0 {
		return nil
	}
	arguments := [][]byte{
		[]byte("MIGRATE"),
		[]byte(target.host),
		[]byte(strconv.FormatUint(uint64(target.port), 10)),
		{},
		[]byte(strconv.FormatUint(uint64(target.index), 10)),
		[]byte(strconv.FormatInt(timeout.Milliseconds(), 10)),
		[]byte("COPY"),
		[]byte("REPLACE"),
		[]byte("AUTH2"),
		[]byte(target.username),
		credential,
		[]byte("KEYS"),
	}
	arguments = append(arguments, keys...)
	value, err := c.command(ctx, arguments...)
	if err != nil || value.kind != replySimple || !bytes.Equal(value.data, []byte("OK")) {
		return ErrOperation
	}
	return nil
}

type keySnapshot struct {
	kind string
	dump []byte
	pttl int64
}

func (snapshot keySnapshot) equal(other keySnapshot, tolerance time.Duration) bool {
	if snapshot.kind != other.kind || !bytes.Equal(snapshot.dump, other.dump) {
		return false
	}
	if snapshot.pttl == -1 || other.pttl == -1 {
		return snapshot.pttl == other.pttl
	}
	if snapshot.pttl < 0 || other.pttl < 0 {
		return snapshot.pttl == other.pttl
	}
	return other.pttl > 0 && other.pttl <= snapshot.pttl && snapshot.pttl-other.pttl <= tolerance.Milliseconds()
}

func (c *respClient) snapshot(ctx context.Context, key []byte) (keySnapshot, error) {
	typeReply, err := c.command(ctx, []byte("TYPE"), key)
	if err != nil || typeReply.kind != replySimple {
		return keySnapshot{}, ErrOperation
	}
	if bytes.Equal(typeReply.data, []byte("none")) {
		return keySnapshot{pttl: -2}, ErrMissingKey
	}
	dumpReply, err := c.command(ctx, []byte("DUMP"), key)
	if err != nil || dumpReply.kind != replyBulk || dumpReply.data == nil {
		return keySnapshot{}, ErrOperation
	}
	ttlReply, err := c.command(ctx, []byte("PTTL"), key)
	if err != nil || ttlReply.kind != replyInteger || ttlReply.integer < -1 {
		return keySnapshot{}, ErrOperation
	}
	return keySnapshot{kind: string(typeReply.data), dump: bytes.Clone(dumpReply.data), pttl: ttlReply.integer}, nil
}

func (c *respClient) delete(ctx context.Context, key []byte) error {
	value, err := c.command(ctx, []byte("DEL"), key)
	if err != nil || value.kind != replyInteger || value.integer < 0 || value.integer > 1 {
		return ErrOperation
	}
	return nil
}
