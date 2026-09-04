package backup

import (
	"strings"

	"github.com/raibitserver/provisioner/internal/providercontract"
	"github.com/raibitserver/provisioner/internal/store"
)

type RecoveryToolPolicy struct{ images map[Engine]string }

func ParseRecoveryToolPolicy(env map[string]string) (RecoveryToolPolicy, error) {
	const prefix = "RAIBITSERVER_RECOVERY_TOOL_"
	images := make(map[Engine]string, 6)
	for _, engine := range []Engine{EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB, EngineRedis, EngineValkey} {
		name := strings.ToUpper(string(engine))
		if engine == EnginePostgreSQL {
			name = "POSTGRESQL"
		}
		image := strings.TrimSpace(env[prefix+name+"_IMAGE"])
		if image != "" && !digestImagePattern.MatchString(image) {
			return RecoveryToolPolicy{}, ErrRecoveryRequest
		}
		if image != "" {
			images[engine] = image
		}
	}
	return RecoveryToolPolicy{images: images}, nil
}

func ParseRequiredRecoveryToolPolicy(env map[string]string) (RecoveryToolPolicy, error) {
	policy, err := ParseRecoveryToolPolicy(env)
	if err != nil || len(policy.images) != 6 {
		return RecoveryToolPolicy{}, ErrRecoveryRequest
	}
	return policy, nil
}

func BindRecoverySource(execution store.RecoveryExecution, policy RecoveryToolPolicy) (Connection, error) {
	if execution.Source.ID != execution.Identity.SourceID {
		return Connection{}, ErrRecoveryRequest
	}
	return bindRecoveryConnection(execution, execution.Source, policy)
}

func BindRecoveryTarget(execution store.RecoveryExecution, policy RecoveryToolPolicy) (Connection, error) {
	if !execution.TargetPrepared || execution.Target == nil {
		return Connection{}, ErrRecoveryRequest
	}
	if execution.Target.ID != execution.Identity.TargetID {
		return Connection{}, ErrRecoveryRequest
	}
	return bindRecoveryConnection(execution, *execution.Target, policy)
}

func bindRecoveryConnection(execution store.RecoveryExecution, metadata store.RecoveryResourceMetadata, policy RecoveryToolPolicy) (Connection, error) {
	engine := Engine(strings.ToLower(metadata.Engine))
	image := policy.images[engine]
	generation, err := NewSourceGeneration(metadata.Generation)
	if err != nil || execution.Identity.OperationID == "" || execution.Identity.Attempt < 1 || metadata.ProjectID != execution.Identity.ProjectID || !digestImagePattern.MatchString(image) || image == metadata.Image {
		return Connection{}, ErrRecoveryRequest
	}
	projection := metadata.Connection
	contract, contractErr := providercontract.RecoveryFor(metadata.Engine, metadata.Name, metadata.Namespace, "", nil)
	if contractErr != nil || projection.Host != contract.Host || projection.Port != contract.Port || projection.SecretKey != contract.CredentialKey || !sameIndex(projection.Index, contract.Index) || projection.SecretName != metadata.SecretName || projection.CredentialUID != metadata.SecretUID || projection.CredentialGeneration != metadata.SecretGeneration {
		return Connection{}, ErrRecoveryRequest
	}
	provenance, err := NewProviderProvenance(ProviderProvenanceSpec{Namespace: metadata.Namespace, Name: metadata.Name, UID: metadata.WorkloadUID, CredentialUID: metadata.SecretUID, CredentialGeneration: metadata.SecretGeneration, Generation: metadata.WorkloadGeneration, Image: metadata.Image})
	if err != nil {
		return Connection{}, err
	}
	endpoint, err := NewNetworkEndpoint(NetworkEndpointSpec{Host: projection.Host, Port: projection.Port, Database: projection.Database, User: projection.User, Index: projection.Index})
	if err != nil {
		return Connection{}, err
	}
	secret, err := NewSecretRef(projection.SecretNamespace, projection.SecretName, projection.SecretKey)
	if err != nil {
		return Connection{}, err
	}
	return newConnection(ConnectionSpec{OrganizationID: execution.Identity.OrganizationID, ProjectID: metadata.ProjectID, ResourceID: metadata.ID, Engine: EngineVersion{Engine: engine, Version: metadata.Version}, Generation: generation, Provenance: provenance, Endpoint: endpoint, Secret: secret}, image, execution.Identity.OperationID, execution.Identity.Attempt)
}

func sameIndex(left, right *uint16) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}
