package recoverywire

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type Decoder struct {
	limits Limits
}

func NewDecoder(limits Limits) Decoder { return Decoder{limits: limits} }

func (d Decoder) Decode(ctx context.Context, dst io.Writer, src io.Reader) (Decoded, error) {
	if dst == nil || src == nil || d.limits.maxBytes == 0 || d.limits.maxFrames == 0 {
		return Decoded{}, ErrLimitExceeded
	}
	reader := bufio.NewReaderSize(cancelAwareReader{ctx: ctx, source: src}, MaxLineLength+1)
	headerLine, err := readLine(ctx, reader)
	if err != nil {
		return Decoded{}, err
	}
	metadata, err := parseHeader(headerLine)
	if err != nil {
		return Decoded{}, err
	}

	state := newDecodeState(ctx, d, dst)
	for {
		line, lineErr := readLine(ctx, reader)
		if lineErr != nil {
			return Decoded{}, lineErr
		}
		if bytes.HasPrefix(line, []byte("D ")) {
			if frameErr := state.consumeDataFrame(line); frameErr != nil {
				return Decoded{}, frameErr
			}
			continue
		}
		if bytes.HasPrefix(line, []byte("E ")) {
			if err := parseTerminal(line, state.receipt, state.digest); err != nil {
				return Decoded{}, err
			}
			if err := requireEOF(ctx, reader); err != nil {
				return Decoded{}, err
			}
			copy(state.receipt.SHA256[:], state.digest.Sum(nil))
			return Decoded{Metadata: metadata, Receipt: state.receipt}, nil
		}
		return Decoded{}, invalid("frame type")
	}
}

type cancelAwareReader struct {
	ctx    context.Context
	source io.Reader
}

func (r cancelAwareReader) Read(buffer []byte) (int, error) {
	if err := cancellation(r.ctx, "decode"); err != nil {
		return 0, err
	}
	n, readErr := r.source.Read(buffer)
	if err := cancellation(r.ctx, "decode"); err != nil {
		return n, err
	}
	return n, readErr
}

func readLine(ctx context.Context, reader *bufio.Reader) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("recovery wire: decode canceled: %w", err)
	}
	line, err := reader.ReadSlice('\n')
	if cancelErr := cancellation(ctx, "decode"); cancelErr != nil {
		return nil, cancelErr
	}
	if errors.Is(err, bufio.ErrBufferFull) || len(line) > MaxLineLength {
		return nil, ErrLimitExceeded
	}
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, invalid("truncated envelope")
		}
		return nil, ioError("read envelope")
	}
	return line[:len(line)-1], nil
}

func parseHeader(line []byte) (Metadata, error) {
	parts := strings.Split(string(line), " ")
	if len(parts) < 5 || parts[0] != magic {
		return Metadata{}, invalid("header")
	}
	metadata, err := NewMetadata(Engine(parts[1]), parts[2], Format(parts[3]))
	if err != nil {
		return Metadata{}, invalid("metadata")
	}
	if len(parts) == 5 && parts[4] == "baseline=none" {
		return metadata, nil
	}
	if len(parts) != 7 {
		return Metadata{}, invalid("baseline fields")
	}
	schemaDigest, err := parseDigestField(parts[4], "schema-sha256=")
	if err != nil {
		return Metadata{}, err
	}
	dataDigest, err := parseDigestField(parts[5], "data-sha256=")
	if err != nil {
		return Metadata{}, err
	}
	recordCountValue, ok := strings.CutPrefix(parts[6], "records=")
	if !ok {
		return Metadata{}, invalid("baseline record count")
	}
	recordCount, err := parseCanonicalUint(recordCountValue)
	if err != nil {
		return Metadata{}, invalid("baseline record count")
	}
	baseline, err := NewBaseline(schemaDigest, dataDigest, recordCount)
	if err != nil {
		return Metadata{}, invalid("baseline")
	}
	metadata, err = metadata.WithBaseline(baseline)
	if err != nil {
		return Metadata{}, invalid("baseline")
	}
	return metadata, nil
}

func parseDigestField(field, prefix string) ([sha256.Size]byte, error) {
	value, ok := strings.CutPrefix(field, prefix)
	if !ok || len(value) != sha256.Size*2 {
		return [sha256.Size]byte{}, invalid("baseline digest")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(decoded) != value {
		return [sha256.Size]byte{}, invalid("baseline digest")
	}
	var digest [sha256.Size]byte
	copy(digest[:], decoded)
	return digest, nil
}

func parseTerminal(line []byte, receipt Receipt, digest interface{ Sum([]byte) []byte }) error {
	parts := strings.Split(string(line), " ")
	if len(parts) != 4 {
		return invalid("terminal frame")
	}
	frames, err := parseCanonicalUint(parts[1])
	if err != nil {
		return invalid("terminal frame count")
	}
	plaintextBytes, err := parseCanonicalUint(parts[2])
	if err != nil {
		return invalid("terminal byte count")
	}
	wantHash, err := hex.DecodeString(parts[3])
	if err != nil || len(wantHash) != sha256.Size || hex.EncodeToString(wantHash) != parts[3] {
		return invalid("terminal hash")
	}
	if frames != receipt.Frames || plaintextBytes != receipt.PlaintextBytes || !bytes.Equal(wantHash, digest.Sum(nil)) {
		return invalid("terminal receipt")
	}
	return nil
}

func parseCanonicalUint(value string) (uint64, error) {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(parsed, 10) != value {
		return 0, ErrInvalidEnvelope
	}
	return parsed, nil
}

func requireEOF(ctx context.Context, reader *bufio.Reader) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("recovery wire: decode canceled: %w", err)
	}
	_, err := reader.ReadByte()
	if cancelErr := cancellation(ctx, "decode"); cancelErr != nil {
		return cancelErr
	}
	if err == nil {
		return invalid("trailing frame")
	}
	if !errors.Is(err, io.EOF) {
		return ioError("read envelope trailer")
	}
	return nil
}
