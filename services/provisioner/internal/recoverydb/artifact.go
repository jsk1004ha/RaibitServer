package recoverydb

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

const scratchReserveBytes uint64 = 64 * 1024 * 1024

type stagedArtifact struct {
	path string
}

func newStagedArtifact(work workspace, name string) (stagedArtifact, *os.File, error) {
	limits := recoverywire.DefaultLimits()
	available, err := availableScratchBytes(work.path)
	if err != nil || !scratchCapacitySufficient(available, limits.MaxBytes()) {
		return stagedArtifact{}, nil, ErrWorkspace
	}
	path := filepath.Join(work.path, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, privateFileMode)
	if err != nil {
		return stagedArtifact{}, nil, ErrWorkspace
	}
	return stagedArtifact{path: path}, file, nil
}

func scratchCapacitySufficient(available, maxArtifactBytes uint64) bool {
	return maxArtifactBytes <= ^uint64(0)-scratchReserveBytes && available >= maxArtifactBytes+scratchReserveBytes
}

func decodeToStage(ctx context.Context, work workspace, src io.Reader) (recoverywire.Decoded, stagedArtifact, error) {
	artifact, file, err := newStagedArtifact(work, "restore.payload")
	if err != nil {
		return recoverywire.Decoded{}, stagedArtifact{}, err
	}
	decoded, decodeErr := recoverywire.NewDecoder(recoverywire.DefaultLimits()).Decode(ctx, file, src)
	closeErr := syncClose(file)
	if decodeErr != nil || closeErr != nil {
		return recoverywire.Decoded{}, stagedArtifact{}, errors.Join(ErrStream, decodeErr, closeErr)
	}
	return decoded, artifact, nil
}

func syncClose(file *os.File) error {
	if err := file.Sync(); err != nil {
		if closeErr := file.Close(); closeErr != nil {
			return ErrWorkspace
		}
		return ErrWorkspace
	}
	if err := file.Close(); err != nil {
		return ErrWorkspace
	}
	return nil
}

func (a stagedArtifact) open() (*os.File, error) {
	file, err := os.Open(a.path)
	if err != nil {
		return nil, ErrWorkspace
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || uint64(info.Size()) > recoverywire.DefaultLimits().MaxBytes() {
		if closeErr := file.Close(); closeErr != nil {
			return nil, ErrWorkspace
		}
		return nil, ErrWorkspace
	}
	return file, nil
}
