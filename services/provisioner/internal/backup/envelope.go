package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"

	"github.com/tink-crypto/tink-go/v2/streamingaead/subtle"
)

// envelopeHeader's declaration order is the v1 canonical AAD order. The complete
// magic+length+JSON prefix is authenticated. Readback compares bytes against the
// trusted record BEFORE selecting the key: no attacker-selected parsing/key lookup.
type envelopeHeader struct {
	Envelope       string `json:"envelope"`
	Version        int    `json:"version"`
	KeyVersion     string `json:"keyVersion"`
	OrganizationID string `json:"organizationId"`
	ResourceID     string `json:"resourceId"`
	BackupID       string `json:"backupId"`
	Attempt        int    `json:"attempt"`
}

func header(a Attempt) ([]byte, error) {
	s := a.spec
	data, err := json.Marshal(envelopeHeader{"raibitserver.backup", 1, s.KeyVersion, s.OrganizationID, s.ResourceID, s.BackupID, s.Number})
	if err != nil || len(data) > 1024 {
		return nil, ErrIdentity
	}
	prefix := append([]byte("RAIBAK01"), make([]byte, 4)...)
	binary.BigEndian.PutUint32(prefix[8:], uint32(len(data)))
	return append(prefix, data...), nil
}

func (s *Service) encrypt(ctx context.Context, req UploadRequest, dst io.Writer) (ArtifactRecord, error) {
	aad, err := header(req.Attempt)
	if err != nil {
		return ArtifactRecord{}, err
	}
	key, ok := s.bundle.keys[req.Attempt.spec.KeyVersion]
	if !ok {
		return ArtifactRecord{}, ErrConfig
	}
	primitive, err := subtle.NewAESGCMHKDF(key[:], "SHA256", 32, SegmentBytes, 0)
	if err != nil {
		return ArtifactRecord{}, ErrConfig
	}
	w := newMeasuredWriter(ctx, dst, s.maxStored)
	if _, err := w.Write(aad); err != nil {
		return ArtifactRecord{}, safeError(err)
	}
	encrypted, err := primitive.NewEncryptingWriter(w, aad)
	if err != nil {
		return ArtifactRecord{}, ErrIntegrity
	}
	plain := &measuredReader{ctx: ctx, src: req.Source, max: s.maxPlain}
	_, copyErr := io.CopyBuffer(encrypted, plain, make([]byte, 64<<10))
	closeErr := encrypted.Close()
	if err := errors.Join(copyErr, closeErr, ctx.Err()); err != nil {
		return ArtifactRecord{}, safeError(err)
	}
	return ArtifactRecord{Attempt: req.Attempt.spec, StoredBytes: w.size, PlaintextBytes: plain.size, SHA256: digest(w.hash)}, nil
}

func (s *Service) decrypt(ctx context.Context, candidate Candidate, src io.Reader, dst io.Writer) error {
	a, err := NewAttempt(candidate.record.Attempt)
	if err != nil {
		return err
	}
	aad, err := header(a)
	if err != nil {
		return err
	}
	r := &measuredReader{ctx: ctx, src: src, hash: sha256.New(), max: s.maxStored}
	actual := make([]byte, len(aad))
	if _, err := io.ReadFull(r, actual); err != nil || !bytes.Equal(actual, aad) {
		return ErrIntegrity
	}
	key, ok := s.bundle.keys[a.spec.KeyVersion]
	if !ok {
		return ErrConfig
	}
	primitive, err := subtle.NewAESGCMHKDF(key[:], "SHA256", 32, SegmentBytes, 0)
	if err != nil {
		return ErrConfig
	}
	plain, err := primitive.NewDecryptingReader(r, aad)
	if err != nil {
		return ErrIntegrity
	}
	w := &measuredWriter{ctx: ctx, dst: dst, max: s.maxPlain}
	if _, err := io.CopyBuffer(w, plain, make([]byte, 64<<10)); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.Join(ErrIntegrity, safeError(err))
	}
	var trailing [1]byte
	if n, err := r.Read(trailing[:]); n != 0 || !errors.Is(err, io.EOF) {
		return ErrIntegrity
	}
	if r.size != candidate.record.StoredBytes || w.size != candidate.record.PlaintextBytes || digest(r.hash) != candidate.record.SHA256 {
		return ErrIntegrity
	}
	return ctx.Err()
}
