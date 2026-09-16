package recoverycache

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strconv"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

type recoveryWireCodec struct{ index uint16 }

func newRecoveryWireCodec(index uint16) artifactCodec { return recoveryWireCodec{index: index} }

func (c recoveryWireCodec) encode(ctx context.Context, metadata artifactMetadata, input io.Reader, output io.Writer, max int64) (artifactTransfer, error) {
	if max < 1 {
		return artifactTransfer{}, ErrLimit
	}
	wireEngine, err := toWireEngine(metadata.engine)
	if err != nil || metadata.keyCount < 0 || metadata.datasetSHA256 == [sha256.Size]byte{} {
		return artifactTransfer{}, ErrOperation
	}
	wireMetadata, err := recoverywire.NewMetadata(wireEngine, metadata.sourceVersion, recoverywire.FormatRDB)
	if err != nil {
		return artifactTransfer{}, ErrOperation
	}
	baseline, err := recoverywire.NewBaseline(cacheSchemaDigest(metadata.engine, metadata.sourceVersion, c.index), metadata.datasetSHA256, uint64(metadata.keyCount))
	if err != nil {
		return artifactTransfer{}, ErrOperation
	}
	wireMetadata, err = wireMetadata.WithBaseline(baseline)
	if err != nil {
		return artifactTransfer{}, ErrOperation
	}
	receipt, err := recoverywire.NewEncoder(recoverywire.DefaultLimits()).Encode(ctx, output, recoverywire.Envelope{
		Metadata: wireMetadata,
		Payload:  &boundedPayloadReader{reader: input, remaining: max},
	})
	if err != nil {
		return artifactTransfer{}, mapWireError(err)
	}
	return artifactTransfer{decodedBytes: receipt.PlaintextBytes, decodedSHA: receipt.SHA256}, nil
}

func (c recoveryWireCodec) decode(ctx context.Context, expected engine, input io.Reader, output io.Writer, max int64) (artifactMetadata, artifactTransfer, error) {
	if max < 1 {
		return artifactMetadata{}, artifactTransfer{}, ErrLimit
	}
	limits, err := recoverywire.NewLimits(uint64(max), uint64(max)/recoverywire.PayloadChunkSize+2)
	if err != nil {
		return artifactMetadata{}, artifactTransfer{}, ErrLimit
	}
	decoded, err := recoverywire.NewDecoder(limits).Decode(ctx, output, input)
	if err != nil {
		return artifactMetadata{}, artifactTransfer{}, mapWireError(err)
	}
	wireEngine, err := toWireEngine(expected)
	if err != nil || decoded.Metadata.Engine() != wireEngine || decoded.Metadata.Format() != recoverywire.FormatRDB {
		return artifactMetadata{}, artifactTransfer{}, ErrOperation
	}
	baseline, ok := decoded.Metadata.Baseline()
	if !ok || baseline.RecordCount() > uint64(maxScannedKeys) || baseline.SchemaSHA256() != cacheSchemaDigest(expected, decoded.Metadata.Version(), c.index) {
		return artifactMetadata{}, artifactTransfer{}, ErrOperation
	}
	if decoded.Receipt.PlaintextBytes == 0 || decoded.Receipt.PlaintextBytes > uint64(max) {
		return artifactMetadata{}, artifactTransfer{}, ErrLimit
	}
	return artifactMetadata{
		engine:        expected,
		sourceVersion: decoded.Metadata.Version(),
		keyCount:      int64(baseline.RecordCount()),
		datasetSHA256: baseline.DataSHA256(),
	}, artifactTransfer{decodedBytes: decoded.Receipt.PlaintextBytes, decodedSHA: decoded.Receipt.SHA256}, nil
}

func toWireEngine(value engine) (recoverywire.Engine, error) {
	switch value {
	case engineRedis:
		return recoverywire.EngineRedis, nil
	case engineValkey:
		return recoverywire.EngineValkey, nil
	default:
		return "", ErrCapability
	}
}

func cacheSchemaDigest(value engine, version string, index uint16) [sha256.Size]byte {
	wireEngine := recoverywire.Engine("")
	switch value {
	case engineRedis:
		wireEngine = recoverywire.EngineRedis
	case engineValkey:
		wireEngine = recoverywire.EngineValkey
	default:
		return [sha256.Size]byte{}
	}
	return sha256.Sum256([]byte(
		"cache-rdb-v1\x00" + string(wireEngine) + "\x00" + version + "\x00" +
			strconv.FormatUint(uint64(index), 10) + "\x00rdb-cap=" +
			strconv.FormatInt(MaxRDBBytes, 10) + "\x00memory-cap=" +
			strconv.FormatInt(MaxSourceMemoryBytes, 10),
	))
}

func mapWireError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, recoverywire.ErrLimitExceeded) || errors.Is(err, ErrLimit) {
		return ErrLimit
	}
	return ErrOperation
}

type boundedPayloadReader struct {
	reader    io.Reader
	remaining int64
	checked   bool
}

func (r *boundedPayloadReader) Read(buffer []byte) (int, error) {
	if r.remaining > 0 {
		if int64(len(buffer)) > r.remaining {
			buffer = buffer[:r.remaining]
		}
		n, err := r.reader.Read(buffer)
		r.remaining -= int64(n)
		return n, err
	}
	if r.checked {
		return 0, io.EOF
	}
	r.checked = true
	var probe [1]byte
	n, err := r.reader.Read(probe[:])
	if n > 0 {
		return 0, ErrLimit
	}
	return 0, err
}
