package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
)

type jobIdentityStep struct {
	Executable string
	Args       []string
	Binding    StreamBinding
}

type jobIdentitySecret struct {
	Name, Namespace, Object, Key, Path string
}

type jobIdentityConnection struct {
	Host, Database, User, Volume, Root, RelativePath string
	ProviderUID, CredentialUID, CredentialGeneration string
	Port                                             uint16
	Index                                            *uint16
	WorkloadGeneration                               int64
}

func isolatedJobIdentity(job IsolatedJob) string {
	spec := job.spec
	steps := make([]jobIdentityStep, len(spec.Steps))
	for i, step := range spec.Steps {
		steps[i] = jobIdentityStep{step.command.executable, step.command.args, step.binding}
	}
	secrets := make([]jobIdentitySecret, 0, len(spec.Secrets)+len(spec.SecretFiles))
	for _, secret := range spec.Secrets {
		secrets = append(secrets, jobIdentitySecret{secret.name, secret.ref.namespace, secret.ref.name, secret.ref.key, ""})
	}
	for _, secret := range spec.SecretFiles {
		secrets = append(secrets, jobIdentitySecret{"", secret.ref.namespace, secret.ref.name, secret.ref.key, secret.mountPath})
	}
	provider := spec.Connection.spec.Provenance.spec
	connection := jobIdentityConnection{ProviderUID: provider.UID, CredentialUID: provider.CredentialUID, CredentialGeneration: provider.CredentialGeneration, WorkloadGeneration: provider.Generation}
	switch endpoint := spec.Connection.Endpoint().(type) {
	case NetworkEndpoint:
		connection.Host, connection.Port, connection.Database, connection.User, connection.Index = endpoint.spec.Host, endpoint.spec.Port, endpoint.spec.Database, endpoint.spec.User, endpoint.spec.Index
	case SQLiteEndpoint:
		connection.Volume, connection.Root, connection.RelativePath = endpoint.spec.Volume, endpoint.spec.Root, endpoint.spec.RelativePath
	}
	payload, err := json.Marshal(struct {
		Namespace, Image, Operation, Resource, Generation    string
		Attempt, RunAsUser, CPU, Memory, Ephemeral, Deadline int64
		Steps                                                []jobIdentityStep
		Secrets                                              []jobIdentitySecret
		Connection                                           jobIdentityConnection
	}{spec.Namespace, spec.Image, spec.OperationID, spec.Connection.ResourceID(), spec.Connection.Generation().String(), int64(spec.Attempt), spec.RunAsUser, spec.CPUMilli, spec.MemoryMiB, spec.EphemeralMiB, int64(spec.Deadline), steps, secrets, connection})
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(payload)
	return "recovery-job/v1:sha256:" + hex.EncodeToString(digest[:])
}

func (j IsolatedJob) Identity() string { return isolatedJobIdentity(j) }

func expectedJobLabels(job IsolatedJob) map[string]string {
	return map[string]string{
		"raibitserver.io/owned-by":      "recovery",
		"raibitserver.io/operation":     job.fence.operationID,
		"raibitserver.io/resource":      job.spec.Connection.ResourceID(),
		"raibitserver.io/attempt":       strconv.Itoa(job.fence.attempt),
		"raibitserver.io/spec-identity": isolatedJobIdentity(job),
	}
}
