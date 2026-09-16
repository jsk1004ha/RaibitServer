package recoverydb

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"regexp"
	"sort"
	"strings"
)

const (
	maxProbeBytes      = 4 * 1024 * 1024
	maxDescriptorBytes = 64 * 1024
	maxDescriptors     = 100_000
)

var baselineVersionPattern = regexp.MustCompile(`^[0-9]{1,6}(?:\.[0-9]{1,3}){0,3}$`)

type engineBaseline struct {
	version         string
	descriptorCount uint64
	schemaSHA256    [32]byte
	dataSHA256      [32]byte
}

type baselineRequest struct {
	engine   engine
	endpoint endpoint
	work     workspace
}

type boundedProbeCapture struct {
	buffer bytes.Buffer
}

func (c *boundedProbeCapture) Write(value []byte) (int, error) {
	if c.buffer.Len()+len(value) > maxProbeBytes {
		return 0, ErrBaseline
	}
	return c.buffer.Write(value)
}

func (c *boundedProbeCapture) Bytes() []byte {
	return c.buffer.Bytes()
}

func parseBaseline(output []byte) (engineBaseline, error) {
	if len(output) > maxProbeBytes {
		return engineBaseline{}, ErrBaseline
	}
	lines := bytes.Split(bytes.TrimSuffix(output, []byte{'\n'}), []byte{'\n'})
	version := ""
	descriptors := make([][]byte, 0, len(lines))
	for _, line := range lines {
		prefix, encoded, ok := strings.Cut(string(line), "\t")
		if !ok {
			return engineBaseline{}, ErrBaseline
		}
		switch prefix {
		case "V":
			if version != "" || !baselineVersionPattern.MatchString(encoded) {
				return engineBaseline{}, ErrBaseline
			}
			version = encoded
		case "D":
			if len(descriptors) >= maxDescriptors || len(encoded) > base64.StdEncoding.EncodedLen(maxDescriptorBytes) {
				return engineBaseline{}, ErrBaseline
			}
			descriptor, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || len(descriptor) > maxDescriptorBytes {
				return engineBaseline{}, ErrBaseline
			}
			descriptors = append(descriptors, descriptor)
		default:
			return engineBaseline{}, ErrBaseline
		}
	}
	if version == "" {
		return engineBaseline{}, ErrBaseline
	}
	sort.Slice(descriptors, func(left, right int) bool { return bytes.Compare(descriptors[left], descriptors[right]) < 0 })
	schemaHasher := sha256.New()
	if _, err := schemaHasher.Write([]byte("raibit-schema-v1\x00")); err != nil {
		return engineBaseline{}, ErrBaseline
	}
	var size [8]byte
	for _, descriptor := range descriptors {
		binary.BigEndian.PutUint64(size[:], uint64(len(descriptor)))
		if _, err := schemaHasher.Write(size[:]); err != nil {
			return engineBaseline{}, ErrBaseline
		}
		if _, err := schemaHasher.Write(descriptor); err != nil {
			return engineBaseline{}, ErrBaseline
		}
	}
	var schemaDigest [32]byte
	copy(schemaDigest[:], schemaHasher.Sum(nil))
	dataDigest, err := structuralDigest(version, schemaDigest, uint64(len(descriptors)))
	if err != nil {
		return engineBaseline{}, err
	}
	return engineBaseline{version: version, descriptorCount: uint64(len(descriptors)), schemaSHA256: schemaDigest, dataSHA256: dataDigest}, nil
}

func structuralDigest(version string, schemaDigest [32]byte, descriptorCount uint64) ([32]byte, error) {
	structuralHasher := sha256.New()
	if _, err := structuralHasher.Write([]byte("raibit-structural-verification-v1\x00")); err != nil {
		return [32]byte{}, ErrBaseline
	}
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(version)))
	for _, field := range [][]byte{size[:], []byte(version), schemaDigest[:]} {
		if _, err := structuralHasher.Write(field); err != nil {
			return [32]byte{}, ErrBaseline
		}
	}
	binary.BigEndian.PutUint64(size[:], descriptorCount)
	if _, err := structuralHasher.Write(size[:]); err != nil {
		return [32]byte{}, ErrBaseline
	}
	var dataDigest [32]byte
	copy(dataDigest[:], structuralHasher.Sum(nil))
	return dataDigest, nil
}

func collectBaseline(ctx context.Context, request baselineRequest, executor processExecutor) (engineBaseline, error) {
	spec, err := buildBaselineProbe(request.engine, request.endpoint, request.work)
	if err != nil {
		return engineBaseline{}, err
	}
	var stdout boundedProbeCapture
	var stderr cappedBuffer
	if err := executor.Execute(ctx, spec, Streams{Stdout: &stdout, Stderr: &stderr}); err != nil {
		if cause := context.Cause(ctx); cause != nil {
			return engineBaseline{}, cause
		}
		return engineBaseline{}, ErrBaseline
	}
	return parseBaseline(stdout.Bytes())
}
