package recoverywire

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
)

const magic = "RAIBIT-RECOVERY/1"

type Encoder struct {
	limits Limits
}

func NewEncoder(limits Limits) Encoder { return Encoder{limits: limits} }

func (e Encoder) Encode(ctx context.Context, dst io.Writer, envelope Envelope) (Receipt, error) {
	if err := cancellation(ctx, "encode"); err != nil {
		return Receipt{}, err
	}
	if e.limits.maxBytes == 0 || e.limits.maxFrames == 0 {
		return Receipt{}, ErrLimitExceeded
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
	writeErr := writeAll(ctx, dst, []byte(header))
	if err := cancellation(ctx, "encode"); err != nil {
		return Receipt{}, err
	}
	if writeErr != nil {
		return Receipt{}, ioError("write header")
	}

	digest := sha256.New()
	buffer := make([]byte, PayloadChunkSize)
	var receipt Receipt
	for {
		if err := cancellation(ctx, "encode"); err != nil {
			return Receipt{}, err
		}
		n, readErr := envelope.Payload.Read(buffer)
		if err := cancellation(ctx, "encode"); err != nil {
			return Receipt{}, err
		}
		if n > 0 {
			if receipt.Frames >= e.limits.maxFrames || receipt.PlaintextBytes > e.limits.maxBytes || uint64(n) > e.limits.maxBytes-receipt.PlaintextBytes {
				return Receipt{}, ErrLimitExceeded
			}
			encoded := base64.StdEncoding.EncodeToString(buffer[:n])
			line := fmt.Sprintf("D %010d %s\n", receipt.Frames, encoded)
			writeErr := writeAll(ctx, dst, []byte(line))
			if err := cancellation(ctx, "encode"); err != nil {
				return Receipt{}, err
			}
			if writeErr != nil {
				return Receipt{}, ioError("write data frame")
			}
			_, _ = digest.Write(buffer[:n])
			receipt.Frames++
			receipt.PlaintextBytes += uint64(n)
		}
		if readErr != nil {
			if readErr != io.EOF {
				return Receipt{}, ioError("read payload")
			}
			break
		}
		if n == 0 {
			return Receipt{}, ioError("read payload")
		}
	}
	copy(receipt.SHA256[:], digest.Sum(nil))
	terminal := fmt.Sprintf("E %d %d %x\n", receipt.Frames, receipt.PlaintextBytes, receipt.SHA256)
	writeErr = writeAll(ctx, dst, []byte(terminal))
	if err := cancellation(ctx, "encode"); err != nil {
		return Receipt{}, err
	}
	if writeErr != nil {
		return Receipt{}, ioError("write terminal frame")
	}
	return receipt, nil
}

func writeAll(ctx context.Context, dst io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := dst.Write(data)
		if cancelErr := cancellation(ctx, "I/O"); cancelErr != nil {
			return cancelErr
		}
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
