package recoverywire

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"math"
)

const magic = "RAIBIT-RECOVERY/1"

type Encoder struct{}

func NewEncoder() Encoder { return Encoder{} }

func (Encoder) Encode(ctx context.Context, dst io.Writer, envelope Envelope) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, fmt.Errorf("recovery wire: encode canceled: %w", err)
	}
	if dst == nil || envelope.Payload == nil || !envelope.Metadata.valid() {
		return Receipt{}, ErrInvalidMetadata
	}
	header := fmt.Sprintf("%s %s %s %s baseline=none\n", magic, envelope.Metadata.engine, envelope.Metadata.version, envelope.Metadata.format)
	if baseline, ok := envelope.Metadata.Baseline(); ok {
		header = fmt.Sprintf(
			"%s %s %s %s schema-sha256=%x data-sha256=%x records=%d\n",
			magic,
			envelope.Metadata.engine,
			envelope.Metadata.version,
			envelope.Metadata.format,
			baseline.schemaSHA256,
			baseline.dataSHA256,
			baseline.recordCount,
		)
	}
	if err := writeAll(dst, []byte(header)); err != nil {
		return Receipt{}, ioError("write header", err)
	}

	digest := sha256.New()
	buffer := make([]byte, PayloadChunkSize)
	var receipt Receipt
	for {
		if err := ctx.Err(); err != nil {
			return Receipt{}, fmt.Errorf("recovery wire: encode canceled: %w", err)
		}
		n, readErr := envelope.Payload.Read(buffer)
		if n > 0 {
			if receipt.Frames == 9_999_999_999 || receipt.PlaintextBytes > math.MaxUint64-uint64(n) {
				return Receipt{}, ErrLimitExceeded
			}
			encoded := base64.StdEncoding.EncodeToString(buffer[:n])
			line := fmt.Sprintf("D %010d %s\n", receipt.Frames, encoded)
			if err := writeAll(dst, []byte(line)); err != nil {
				return Receipt{}, ioError("write data frame", err)
			}
			_, _ = digest.Write(buffer[:n])
			receipt.Frames++
			receipt.PlaintextBytes += uint64(n)
		}
		if readErr != nil {
			if readErr != io.EOF {
				return Receipt{}, ioError("read payload", readErr)
			}
			break
		}
		if n == 0 {
			return Receipt{}, ioError("read payload", io.ErrNoProgress)
		}
	}
	copy(receipt.SHA256[:], digest.Sum(nil))
	terminal := fmt.Sprintf("E %d %d %x\n", receipt.Frames, receipt.PlaintextBytes, receipt.SHA256)
	if err := writeAll(dst, []byte(terminal)); err != nil {
		return Receipt{}, ioError("write terminal frame", err)
	}
	return receipt, nil
}

func writeAll(dst io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := dst.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
