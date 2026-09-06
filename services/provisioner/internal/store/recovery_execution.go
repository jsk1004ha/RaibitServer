package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/raibitserver/provisioner/internal/providercontract"
)

type RecoveryConnectionProjection struct {
	Host, Database, User, SecretNamespace, SecretName, SecretKey, CredentialUID, CredentialGeneration string
	Port                                                                                              uint16
	Index                                                                                             *uint16
}

type RecoveryResourceMetadata struct {
	ID, ProjectID, Engine, Provider, Version, Namespace, Name, SecretName, SecretUID, SecretGeneration, Image, WorkloadUID string
	WorkloadGeneration                                                                                                     int64
	Generation                                                                                                             string
	Connection                                                                                                             RecoveryConnectionProjection
}

type RecoveryExecution struct {
	Identity       RecoveryIdentity
	Source         RecoveryResourceMetadata
	Target         *RecoveryResourceMetadata
	TargetPrepared bool
}

func (s *PostgresStore) ReadRecoveryExecution(ctx context.Context, c RecoveryClaim) (RecoveryExecution, error) {
	var result RecoveryExecution
	err := s.withRecovery(ctx, c, func(tx *sql.Tx, l *recoveryLocked) error {
		source, err := recoveryResourceMetadata(l.source)
		if err != nil {
			return err
		}
		result = RecoveryExecution{Identity: c.Identity(), Source: source}
		if l.target != nil {
			result.TargetPrepared = l.target.DesiredState["recoveryPrepared"] == true
			if result.TargetPrepared {
				target, err := recoveryResourceMetadata(l.target)
				if err != nil {
					return err
				}
				result.Target = &target
			}
		}
		return nil
	})
	return result, err
}

func recoveryResourceMetadata(r *Resource) (RecoveryResourceMetadata, error) {
	state, err := json.Marshal(r.DesiredState)
	if err != nil {
		return RecoveryResourceMetadata{}, ErrRecoverySource
	}
	var p recoveryProvenance
	if json.Unmarshal(state, &p) != nil {
		return RecoveryResourceMetadata{}, ErrRecoverySource
	}
	generation, err := recoverySourceGeneration(r)
	if err != nil {
		return RecoveryResourceMetadata{}, err
	}
	connection, err := recoveryConnection(r, p, generation)
	if err != nil {
		return RecoveryResourceMetadata{}, err
	}
	return RecoveryResourceMetadata{ID: r.ID, ProjectID: r.ProjectID, Engine: r.Engine, Provider: r.Provider, Version: r.Version, Namespace: p.ProviderIdentity.Namespace, Name: p.ProviderIdentity.Name, SecretName: r.ConnectionSecretName, SecretUID: p.CredentialUID, SecretGeneration: p.CredentialGeneration, Image: p.ProviderImage.Image, WorkloadUID: p.ProviderImage.WorkloadUID, WorkloadGeneration: p.ProviderImage.WorkloadGeneration, Generation: generation, Connection: connection}, nil
}

func recoveryConnection(r *Resource, provenance recoveryProvenance, generation string) (RecoveryConnectionProjection, error) {
	if strings.EqualFold(r.Engine, "sqlite") {
		return RecoveryConnectionProjection{}, fmt.Errorf("%w: SQLite recovery volume authority is not configured", ErrRecoverySource)
	}
	contract, err := providercontract.RecoveryFor(r.Engine, provenance.ProviderIdentity.Name, provenance.ProviderIdentity.Namespace, r.Name, r.DesiredSpec)
	if err != nil {
		return RecoveryConnectionProjection{}, ErrRecoverySource
	}
	state, ok := r.DesiredState["providerConnection"].(map[string]any)
	if !ok {
		return RecoveryConnectionProjection{}, ErrRecoverySource
	}
	keys, ok := stringSlice(state["environmentKeys"])
	sort.Strings(keys)
	endpoint := strings.TrimSpace(stringMapValue(state, "endpoint"))
	secret := strings.TrimSpace(stringMapValue(state, "secretName"))
	wantEndpoint := net.JoinHostPort(contract.Host, strconv.Itoa(int(contract.Port)))
	providerResult, resultOK := r.DesiredState["providerResult"].(map[string]any)
	resultKeys, keysOK := stringSlice(providerResult["environmentKeys"])
	sort.Strings(resultKeys)
	database, user := stringMapValue(state, "database"), stringMapValue(state, "user")
	if !ok || !resultOK || !keysOK || stringMapValue(state, "sourceGeneration") != generation || endpoint != wantEndpoint || stringMapValue(state, "engine") != strings.ToLower(r.Engine) || stringMapValue(state, "host") != contract.Host || intMapValue(state, "port") != int(contract.Port) || database != contract.Database || user != contract.User || stringMapValue(state, "secretKey") != contract.CredentialKey || stringMapValue(state, "credentialUID") != provenance.CredentialUID || stringMapValue(state, "credentialGeneration") != provenance.CredentialGeneration || secret != r.ConnectionSecretName || secret != provenance.ProviderIdentity.Name+"-connection" || !slices.Equal(keys, contract.EnvironmentKeys) || !slices.Equal(resultKeys, contract.EnvironmentKeys) || stringMapValue(providerResult, "engine") != strings.ToLower(r.Engine) || stringMapValue(providerResult, "provider") != r.Provider || stringMapValue(providerResult, "endpoint") != wantEndpoint || stringMapValue(providerResult, "database") != database || stringMapValue(providerResult, "user") != user || stringMapValue(providerResult, "namespace") != provenance.ProviderIdentity.Namespace || stringMapValue(providerResult, "name") != provenance.ProviderIdentity.Name || stringMapValue(providerResult, "secretName") != secret || provenance.CredentialUID == "" || provenance.CredentialGeneration == "" {
		return RecoveryConnectionProjection{}, ErrRecoverySource
	}
	return RecoveryConnectionProjection{Host: contract.Host, Port: contract.Port, Database: database, User: user, Index: contract.Index, SecretNamespace: provenance.ProviderIdentity.Namespace, SecretName: secret, SecretKey: contract.CredentialKey, CredentialUID: provenance.CredentialUID, CredentialGeneration: provenance.CredentialGeneration}, nil
}

func providerConnectionState(r *Resource, desiredState map[string]any, provider, secretName, endpoint string, secretKeys []string) (map[string]any, error) {
	legacy := map[string]any{"secretName": secretName, "environmentKeys": secretKeys, "endpoint": endpoint}
	result, ok := desiredState["providerResult"].(map[string]any)
	if !ok {
		if providercontract.SupportsRecovery(r.Engine) {
			return nil, ErrRecoverySource
		}
		return legacy, nil
	}
	identity, identityOK := desiredState["providerIdentity"].(map[string]any)
	name, namespace := stringMapValue(identity, "name"), stringMapValue(identity, "namespace")
	contract, err := providercontract.RecoveryFor(r.Engine, name, namespace, r.Name, r.DesiredSpec)
	if err != nil {
		return legacy, nil
	}
	keys := slices.Clone(secretKeys)
	sort.Strings(keys)
	resultKeys, resultKeysOK := stringSlice(result["environmentKeys"])
	sort.Strings(resultKeys)
	if !identityOK || !resultKeysOK || stringMapValue(result, "engine") != strings.ToLower(r.Engine) || stringMapValue(result, "provider") != provider || stringMapValue(result, "name") != name || stringMapValue(result, "namespace") != namespace || endpoint != net.JoinHostPort(contract.Host, strconv.Itoa(int(contract.Port))) || secretName != name+"-connection" || secretName != stringMapValue(result, "secretName") || stringMapValue(result, "database") != contract.Database || stringMapValue(result, "user") != contract.User || !slices.Equal(keys, contract.EnvironmentKeys) || !slices.Equal(resultKeys, contract.EnvironmentKeys) {
		return nil, ErrRecoverySource
	}
	uid, _ := desiredState["credentialSecretUID"].(string)
	generation, _ := desiredState["credentialSecretGeneration"].(string)
	if uid == "" || generation == "" {
		return nil, ErrRecoverySource
	}
	snapshot := *r
	snapshot.Provider = provider
	snapshot.ConnectionSecretName = secretName
	snapshot.DesiredState = desiredState
	sourceGeneration, generationErr := recoverySourceGeneration(&snapshot)
	if generationErr != nil {
		return nil, generationErr
	}
	return map[string]any{"engine": strings.ToLower(r.Engine), "host": contract.Host, "port": int(contract.Port), "database": contract.Database, "user": contract.User, "secretName": secretName, "secretKey": contract.CredentialKey, "credentialUID": uid, "credentialGeneration": generation, "environmentKeys": keys, "endpoint": endpoint, "sourceGeneration": sourceGeneration}, nil
}

func stringMapValue(values map[string]any, key string) string {
	value, _ := values[key].(string)
	return value
}

func intMapValue(values map[string]any, key string) int {
	switch value := values[key].(type) {
	case int:
		return value
	case float64:
		return int(value)
	default:
		return 0
	}
}

func stringSlice(value any) ([]string, bool) {
	values, ok := value.([]any)
	if !ok {
		if direct, directOK := value.([]string); directOK {
			return slices.Clone(direct), true
		}
		return nil, false
	}
	result := make([]string, len(values))
	for i, value := range values {
		result[i], ok = value.(string)
		if !ok {
			return nil, false
		}
	}
	return result, true
}
