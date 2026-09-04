package recoverywire

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"hash"
	"io"
	"strconv"
	"strings"
)

type decodeState struct {
	ctx          context.Context
	decoder      Decoder
	destination  io.Writer
	digest       hash.Hash
	buffer       []byte
	receipt      Receipt
	previousSize int
}

func newDecodeState(ctx context.Context, decoder Decoder, destination io.Writer) *decodeState {
	return &decodeState{
		ctx:          ctx,
		decoder:      decoder,
		destination:  destination,
		digest:       sha256.New(),
		buffer:       make([]byte, PayloadChunkSize),
		previousSize: PayloadChunkSize,
	}
}

func (s *decodeState) consumeDataFrame(line []byte) error {
	if s.previousSize != PayloadChunkSize {
		return invalid("data frame size")
	}
	parts := strings.Split(string(line), " ")
	if len(parts) != 3 || len(parts[1]) != 10 || parts[2] == "" {
		return invalid("data frame")
	}
	sequence, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil || fmt.Sprintf("%010d", sequence) != parts[1] || sequence != s.receipt.Frames {
		return invalid("data sequence")
	}
	if s.receipt.Frames >= s.decoder.limits.maxFrames || len(parts[2]) > base64.StdEncoding.EncodedLen(PayloadChunkSize) {
		return ErrLimitExceeded
	}
	n, err := base64.StdEncoding.Strict().Decode(s.buffer, []byte(parts[2]))
	if err != nil || n == 0 || base64.StdEncoding.EncodeToString(s.buffer[:n]) != parts[2] {
		return invalid("base64 payload")
	}
	if uint64(n) > s.decoder.limits.maxBytes-s.receipt.PlaintextBytes {
		return ErrLimitExceeded
	}
	writeErr := writeAll(s.ctx, s.destination, s.buffer[:n])
	if err := cancellation(s.ctx, "decode"); err != nil {
		return err
	}
	if writeErr != nil {
		return ioError("write payload")
	}
	_, _ = s.digest.Write(s.buffer[:n])
	s.receipt.Frames++
	s.receipt.PlaintextBytes += uint64(n)
	s.previousSize = n
	return nil
}
