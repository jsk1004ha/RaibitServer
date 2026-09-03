package store

import (
	"context"
	"database/sql"
	"encoding/json"
)

type RecoveryResourceMetadata struct {
	ID, ProjectID, Engine, Provider, Version, Namespace, Name, SecretName, SecretUID, SecretGeneration, Image, WorkloadUID string
	WorkloadGeneration                                                                                                     int64
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
	if _, err = recoverySourceGeneration(r); err != nil {
		return RecoveryResourceMetadata{}, err
	}
	return RecoveryResourceMetadata{r.ID, r.ProjectID, r.Engine, r.Provider, r.Version, p.ProviderIdentity.Namespace, p.ProviderIdentity.Name, r.ConnectionSecretName, p.CredentialUID, p.CredentialGeneration, p.ProviderImage.Image, p.ProviderImage.WorkloadUID, p.ProviderImage.WorkloadGeneration}, nil
}
