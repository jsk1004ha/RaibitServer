package recoverycache

import (
	"context"
	"crypto/sha256"
	"io"
)

type artifactMetadata struct {
	engine        engine
	sourceVersion string
	keyCount      int64
	datasetSHA256 [32]byte
}

type artifactTransfer struct {
	decodedBytes uint64
	decodedSHA   [sha256.Size]byte
}

type artifactCodec interface {
	encode(context.Context, artifactMetadata, io.Reader, io.Writer, int64) (artifactTransfer, error)
	decode(context.Context, engine, io.Reader, io.Writer, int64) (artifactMetadata, artifactTransfer, error)
}
