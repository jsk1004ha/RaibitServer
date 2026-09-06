package recoveryreceipt

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"io/fs"
	"os"
)

type scratchClaimSpec struct {
	name         string
	maxBytes     int64
	beforeOpen   func(*os.Root, string) error
	beforeRemove func(*os.Root, string) error
}

type claimedScratch struct {
	root *os.Root
	name string
	file *os.File
	hook func(*os.Root, string) error
}

func claimScratch(root stageRoot, spec scratchClaimSpec) (claimedScratch, error) {
	nonce, err := stageNonce()
	if err != nil {
		return claimedScratch{}, ErrStage
	}
	claimed := stageClaimPrefix + nonce
	if err := root.root.Rename(spec.name, claimed); err != nil {
		return claimedScratch{}, ErrStage
	}
	pathInfo, err := root.root.Lstat(claimed)
	if err != nil || pathInfo.Mode()&fs.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() || pathInfo.Size() <= 0 || pathInfo.Size() > spec.maxBytes {
		return claimedScratch{}, ErrStage
	}
	if spec.beforeOpen != nil {
		if err := spec.beforeOpen(root.root, claimed); err != nil {
			return claimedScratch{}, ErrStage
		}
	}
	file, err := openStageFile(root.root, root.directory, claimed)
	if err != nil {
		return claimedScratch{}, ErrStage
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(pathInfo, actual) || !secureStageObject(file, actual, false) {
		if closeErr := file.Close(); closeErr != nil {
			return claimedScratch{}, ErrStage
		}
		return claimedScratch{}, ErrStage
	}
	return claimedScratch{root: root.root, name: claimed, file: file, hook: spec.beforeRemove}, nil
}

func (c claimedScratch) close() error {
	if c.hook != nil {
		if err := c.hook(c.root, c.name); err != nil {
			return errors.Join(c.file.Close(), ErrStage)
		}
	}
	pathInfo, pathErr := c.root.Lstat(c.name)
	actual, statErr := c.file.Stat()
	if pathErr != nil || statErr != nil || !os.SameFile(pathInfo, actual) {
		return errors.Join(c.file.Close(), ErrStage)
	}
	return errors.Join(c.root.Remove(c.name), c.file.Close())
}

func publishScratch(root stageRoot, name string, source io.Reader, maxBytes int64) (result EvidenceDescriptor, resultErr error) {
	nonce, err := stageNonce()
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	temporaryName := ".recovery-stage-write-" + nonce
	temporary, err := root.root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	cleanup := true
	defer func() {
		if cleanup {
			if err := root.root.Remove(temporaryName); err != nil && !errors.Is(err, fs.ErrNotExist) {
				result, resultErr = EvidenceDescriptor{}, ErrStage
			}
		}
	}()
	digest := sha256.New()
	written, writeErr := io.Copy(io.MultiWriter(temporary, digest), io.LimitReader(source, maxBytes+1))
	syncErr := temporary.Sync()
	info, statErr := temporary.Stat()
	secure := statErr == nil && secureStageObject(temporary, info, false)
	closeErr := temporary.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil || !secure || written <= 0 || written > maxBytes {
		return EvidenceDescriptor{}, ErrStage
	}
	if err := root.root.Link(temporaryName, name); err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	if err := root.root.Remove(temporaryName); err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	cleanup = false
	if err := syncStageDirectory(root.directory); err != nil {
		return EvidenceDescriptor{}, ErrStage
	}
	return evidenceDescriptor(uint64(written), digest), nil
}

func evidenceDescriptor(bytes uint64, digest hash.Hash) EvidenceDescriptor {
	return EvidenceDescriptor{bytes: bytes, sha256: hex.EncodeToString(digest.Sum(nil))}
}

func authenticateEvidence(file *os.File, expected EvidenceDescriptor) error {
	if !expected.valid() {
		return ErrStage
	}
	digest := sha256.New()
	read, err := io.Copy(digest, io.LimitReader(file, StageEvidenceMaxBytes+1))
	if err != nil || uint64(read) != expected.bytes || hex.EncodeToString(digest.Sum(nil)) != expected.sha256 {
		return ErrStage
	}
	return nil
}
