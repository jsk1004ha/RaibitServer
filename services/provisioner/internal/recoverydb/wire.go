package recoverydb

import (
	"context"
	"io"
	"strconv"
	"strings"

	"github.com/raibitserver/provisioner/internal/recoverywire"
)

// SQL and MongoDB baselines are structural verification vectors. Their data
// digest domain-separates version/schema/count and never claims row equality.
func wireMetadata(selected engine, baseline engineBaseline) (recoverywire.Metadata, error) {
	wireEngine, format, err := wireIdentity(selected)
	if err != nil {
		return recoverywire.Metadata{}, err
	}
	metadata, err := recoverywire.NewMetadata(wireEngine, baseline.version, format)
	if err != nil {
		return recoverywire.Metadata{}, ErrBaseline
	}
	wireBaseline, err := recoverywire.NewBaseline(baseline.schemaSHA256, baseline.dataSHA256, baseline.descriptorCount)
	if err != nil {
		return recoverywire.Metadata{}, ErrBaseline
	}
	metadata, err = metadata.WithBaseline(wireBaseline)
	if err != nil {
		return recoverywire.Metadata{}, ErrBaseline
	}
	return metadata, nil
}

func wireIdentity(selected engine) (recoverywire.Engine, recoverywire.Format, error) {
	switch selected {
	case enginePostgreSQL:
		return recoverywire.EnginePostgreSQL, recoverywire.FormatPGCustom, nil
	case engineMySQL:
		return recoverywire.EngineMySQL, recoverywire.FormatSQL, nil
	case engineMariaDB:
		return recoverywire.EngineMariaDB, recoverywire.FormatSQL, nil
	case engineMongoDB:
		return recoverywire.EngineMongoDB, recoverywire.FormatMongoArchiveGzip, nil
	default:
		return "", "", ErrInvalidInput
	}
}

func verifyDecoded(selected engine, decoded recoverywire.Decoded, target engineBaseline) error {
	if err := verifyDecodedIdentity(selected, decoded, target.version); err != nil {
		return err
	}
	source, _ := decoded.Metadata.Baseline()
	if source.SchemaSHA256() != target.schemaSHA256 || source.RecordCount() != target.descriptorCount {
		return ErrBaseline
	}
	return nil
}

func verifyDecodedIdentity(selected engine, decoded recoverywire.Decoded, targetVersion string) error {
	wireEngine, format, err := wireIdentity(selected)
	if err != nil {
		return err
	}
	if decoded.Metadata.Engine() != wireEngine || decoded.Metadata.Format() != format || !compatibleMajor(selected, decoded.Metadata.Version(), targetVersion) || decoded.Receipt.PlaintextBytes == 0 || decoded.Receipt.SHA256 == ([32]byte{}) {
		return ErrBaseline
	}
	source, ok := decoded.Metadata.Baseline()
	if !ok {
		return ErrBaseline
	}
	wantDataDigest, err := structuralDigest(decoded.Metadata.Version(), source.SchemaSHA256(), source.RecordCount())
	if err != nil || wantDataDigest != source.DataSHA256() {
		return ErrBaseline
	}
	return nil
}

func compatibleMajor(selected engine, source, target string) bool {
	sourceMajor := majorVersion(selected, source)
	return sourceMajor != "" && sourceMajor == majorVersion(selected, target)
}

func majorVersion(selected engine, version string) string {
	if selected == enginePostgreSQL && !strings.Contains(version, ".") {
		numeric, err := strconv.Atoi(version)
		if err != nil || numeric < 100000 {
			return ""
		}
		return strconv.Itoa(numeric / 10000)
	}
	major, _, _ := strings.Cut(version, ".")
	if _, err := strconv.Atoi(major); err != nil {
		return ""
	}
	return major
}

func encodeArtifact(ctx context.Context, metadata recoverywire.Metadata, artifact stagedArtifact, dst io.Writer) (recoverywire.Receipt, error) {
	file, err := artifact.open()
	if err != nil {
		return recoverywire.Receipt{}, err
	}
	receipt, encodeErr := recoverywire.NewEncoder(recoverywire.DefaultLimits()).Encode(ctx, dst, recoverywire.Envelope{Metadata: metadata, Payload: file})
	if closeErr := file.Close(); closeErr != nil {
		return recoverywire.Receipt{}, ErrWorkspace
	}
	if encodeErr != nil {
		return recoverywire.Receipt{}, ErrStream
	}
	return receipt, nil
}
