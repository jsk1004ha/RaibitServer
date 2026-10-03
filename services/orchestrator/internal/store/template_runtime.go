package store

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	maxTemplateRuntimeSnapshot = 256 << 10
	maxTemplateRuntimeRefs     = 128
	maxTemplateSealedValue     = 96 << 10
)

var (
	ErrTemplateRuntimeSnapshot = errors.New("template runtime snapshot is invalid")
	ErrTemplateRuntimeScope    = errors.New("template runtime reference scope is invalid")
	ErrTemplateRuntimeResource = errors.New("template runtime resource is not ready")
	ErrTemplateRuntimeSecret   = errors.New("template runtime secret cannot be opened")
	ErrTemplateRuntimeKey      = errors.New("template runtime encryption key is not configured")
	templateEnvironmentName    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	templateKubernetesName     = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)
)

type TemplateResourceSecretRef struct {
	EnvName    string
	SecretName string
	SecretKey  string
}

type TemplateSealedSecret struct {
	EnvName     string `json:"-"`
	SecretID    string `json:"-"`
	SealedValue string `json:"-"`
}

type TemplateRuntimeInputs struct {
	ProjectID     string
	EnvironmentID string
	ServiceID     string
	DeploymentID  string
	ResourceRefs  []TemplateResourceSecretRef
	SealedSecrets []TemplateSealedSecret `json:"-"`
}

type TemplateRuntimeSource interface {
	LoadTemplateRuntimeInputs(context.Context, DeploymentLease, time.Duration) (*TemplateRuntimeInputs, error)
}

type TemplateRuntimeSecretCollector interface {
	TemplateSecretCollectible(context.Context, string, string, string, string, time.Duration) (bool, error)
}

type templateSnapshotRefs struct {
	environmentID string
	resources     []templateResourceRef
	secrets       []templateSecretRef
}

type templateResourceRef struct{ envName, logicalSlug, secretKey, resourceID string }
type templateSecretRef struct{ envName, secretID string }

const templateRuntimeAuthoritySQL = `
SELECT d."projectId",d."serviceId",d."environmentId",e.kind,d."desiredSpecSnapshot"
FROM "Deployment" d
JOIN "Service" s ON s.id=d."serviceId" AND s."projectId"=d."projectId"
JOIN "Project" p ON p.id=d."projectId"
JOIN "EnvironmentService" b ON b."serviceId"=s.id AND b."projectId"=s."projectId" AND b."environmentId"=d."environmentId"
JOIN "Environment" e ON e.id=b."environmentId" AND e."projectId"=b."projectId"
WHERE d.id=$1 AND d.status=$2 AND d."reconcileLockedBy"=$3 AND d."reconcileAttempts"=$4 AND d."reconcileAction"=$5
  AND d."reconcileLockedAt" + ($6::bigint * interval '1 millisecond') > (clock_timestamp() AT TIME ZONE 'UTC')
  AND UPPER(s.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED')
  AND UPPER(p.status) NOT IN ('DELETE_REQUESTED','DELETING','DELETED')
  AND s."deletionRequestedAt" IS NULL AND p."deletionRequestedAt" IS NULL
  AND e.status='active' AND e.kind IN ('prod','dev')
FOR SHARE OF d,s,p,b,e`

const templateRuntimeResourceSQL = `
SELECT r.status,r."connectionSecretName",r."desiredState"
FROM "Resource" r JOIN "EnvironmentResource" b ON b."resourceId"=r.id AND b."projectId"=r."projectId"
WHERE r.id=$1 AND r."projectId"=$2 AND b."environmentId"=$3 AND b."logicalSlug"=$4
  AND r.status='READY' AND r."deletionRequestedAt" IS NULL
  AND r."desiredState"->>'recoveryPublicationBlocked' IS DISTINCT FROM 'true'
  AND r."desiredState"->>'recoveryPrepared' IS DISTINCT FROM 'true'
  AND NOT EXISTS (SELECT 1 FROM "ResourceRecoveryPin" pin WHERE pin."resourceId"=r.id AND pin.kind='RESTORE_TARGET')
FOR SHARE OF r,b`

const templateRuntimeSecretSQL = `SELECT "sealedValue",metadata FROM "SecretValue"
WHERE id=$1 AND "scopeType"='project' AND "scopeId"=$2 FOR SHARE`

const templateSecretCollectibleSQL = `
SELECT EXISTS (
 SELECT 1 FROM "Service" s
 JOIN "Project" p ON p.id=s."projectId"
 JOIN "EnvironmentService" b ON b."serviceId"=s.id AND b."projectId"=p.id
 JOIN "Environment" e ON e.id=b."environmentId" AND e."projectId"=p.id
 LEFT JOIN "Deployment" d ON d.id=$4
 WHERE p.id=$1 AND e.id=$2 AND s.id=$3
   AND (d.id IS NULL OR (d."projectId"=p.id AND d."environmentId"=e.id AND d."serviceId"=s.id
     AND NOT (d.status='DEPLOYING' AND COALESCE(d."reconcileLockedAt" + ($5::bigint * interval '1 millisecond') > (clock_timestamp() AT TIME ZONE 'UTC'),false))))
)`

// The caller must also fence its current reconciliation or service deletion and
// preserve Secrets referenced by workloads. This query protects live producers.
func (s *PostgresStore) TemplateSecretCollectible(ctx context.Context, projectID, environmentID, serviceID, deploymentID string, duration time.Duration) (bool, error) {
	if projectID == "" || environmentID == "" || serviceID == "" || deploymentID == "" {
		return false, ErrTemplateRuntimeScope
	}
	if duration <= 0 {
		duration = 15 * time.Minute
	}
	var collectible bool
	if err := s.db.QueryRowContext(ctx, templateSecretCollectibleSQL, projectID, environmentID, serviceID, deploymentID, duration.Milliseconds()).Scan(&collectible); err != nil {
		return false, fmt.Errorf("check template secret collection authority: %w", err)
	}
	return collectible, nil
}

func (s *PostgresStore) LoadTemplateRuntimeInputs(ctx context.Context, lease DeploymentLease, duration time.Duration) (*TemplateRuntimeInputs, error) {
	if duration <= 0 {
		duration = 15 * time.Minute
	}
	tx, err := s.beginOperationalTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin template runtime read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var projectID, serviceID, environmentID, environmentKind string
	var snapshot []byte
	loadAuthority := func() error {
		return tx.QueryRowContext(ctx, templateRuntimeAuthoritySQL, lease.DeploymentID, DeploymentStatusDeploying, lease.WorkerID, lease.Attempt, lease.Action, duration.Milliseconds()).
			Scan(&projectID, &serviceID, &environmentID, &environmentKind, &snapshot)
	}
	err = loadAuthority()
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeploymentLeaseLost
	}
	if err != nil {
		return nil, fmt.Errorf("load template runtime deployment: %w", err)
	}
	refs, template, err := decodeTemplateRuntimeSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if !template {
		return nil, nil
	}
	if refs.environmentID != environmentID {
		return nil, ErrTemplateRuntimeScope
	}
	inputs := &TemplateRuntimeInputs{ProjectID: projectID, EnvironmentID: environmentID, ServiceID: serviceID, DeploymentID: lease.DeploymentID}
	for _, ref := range refs.resources {
		var status, secretName string
		var desiredState []byte
		err = tx.QueryRowContext(ctx, templateRuntimeResourceSQL, ref.resourceID, projectID, environmentID, ref.logicalSlug).
			Scan(&status, &secretName, &desiredState)
		if err != nil || status != "READY" || len(desiredState) > maxTemplateRuntimeSnapshot {
			return nil, ErrTemplateRuntimeResource
		}
		var state struct {
			ProviderConnection struct {
				SecretName      string   `json:"secretName"`
				EnvironmentKeys []string `json:"environmentKeys"`
			} `json:"providerConnection"`
		}
		if json.Unmarshal(desiredState, &state) != nil || secretName == "" || state.ProviderConnection.SecretName != secretName || !containsString(state.ProviderConnection.EnvironmentKeys, ref.secretKey) || len(secretName) > 63 || !templateKubernetesName.MatchString(secretName) {
			return nil, ErrTemplateRuntimeResource
		}
		inputs.ResourceRefs = append(inputs.ResourceRefs, TemplateResourceSecretRef{EnvName: ref.envName, SecretName: secretName, SecretKey: ref.secretKey})
	}
	for _, ref := range refs.secrets {
		var sealed string
		var metadata []byte
		err = tx.QueryRowContext(ctx, templateRuntimeSecretSQL, ref.secretID, projectID).Scan(&sealed, &metadata)
		if err != nil || len(sealed) > maxTemplateSealedValue || len(metadata) > maxTemplateRuntimeSnapshot || validateTemplateSecretEnvironment(metadata, environmentID, environmentKind) != nil {
			return nil, ErrTemplateRuntimeScope
		}
		inputs.SealedSecrets = append(inputs.SealedSecrets, TemplateSealedSecret{EnvName: ref.envName, SecretID: ref.secretID, SealedValue: sealed})
	}
	// Locks prevent reclaim while loading; the database clock can still expire.
	if err := loadAuthority(); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeploymentLeaseLost
	} else if err != nil {
		return nil, fmt.Errorf("recheck template runtime authority: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit template runtime read: %w", err)
	}
	return inputs, nil
}

func decodeTemplateRuntimeSnapshot(raw json.RawMessage) (templateSnapshotRefs, bool, error) {
	if len(raw) == 0 {
		return templateSnapshotRefs{}, false, nil
	}
	if len(raw) > maxTemplateRuntimeSnapshot || !json.Valid(raw) {
		return templateSnapshotRefs{}, false, ErrTemplateRuntimeSnapshot
	}
	var snapshot struct {
		SourceType string `json:"sourceType"`
		Source     struct {
			Type string `json:"type"`
		} `json:"source"`
		EnvironmentID            string                                                  `json:"environmentId"`
		SecretRefs               []struct{ Name, SecretRef string }                      `json:"secretRefs"`
		ResourceDependencies     []struct{ Name, ResourceLogicalSlug, SecretKey string } `json:"resourceDependencies"`
		TemplateResourceBindings []struct{ ResourceID, ResourceLogicalSlug string }      `json:"templateResourceBindings"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return templateSnapshotRefs{}, false, ErrTemplateRuntimeSnapshot
	}
	template := snapshot.SourceType == "template" || snapshot.Source.Type == "template"
	if !template {
		return templateSnapshotRefs{}, false, nil
	}
	if snapshot.SourceType != "template" || snapshot.Source.Type != "template" || snapshot.EnvironmentID == "" || len(snapshot.SecretRefs)+len(snapshot.ResourceDependencies)+len(snapshot.TemplateResourceBindings) > maxTemplateRuntimeRefs {
		return templateSnapshotRefs{}, true, ErrTemplateRuntimeSnapshot
	}
	bindings := make(map[string]string, len(snapshot.TemplateResourceBindings))
	for _, binding := range snapshot.TemplateResourceBindings {
		if binding.ResourceID == "" || binding.ResourceLogicalSlug == "" || bindings[binding.ResourceLogicalSlug] != "" {
			return templateSnapshotRefs{}, true, ErrTemplateRuntimeSnapshot
		}
		bindings[binding.ResourceLogicalSlug] = binding.ResourceID
	}
	refs := templateSnapshotRefs{environmentID: snapshot.EnvironmentID}
	seen := map[string]bool{}
	for _, secret := range snapshot.SecretRefs {
		secretID, valid := strings.CutPrefix(secret.SecretRef, "secret:")
		if !valid || secretID == "" || !validTemplateEnv(secret.Name, seen) {
			return templateSnapshotRefs{}, true, ErrTemplateRuntimeSnapshot
		}
		refs.secrets = append(refs.secrets, templateSecretRef{secret.Name, secretID})
	}
	for _, resource := range snapshot.ResourceDependencies {
		resourceID := bindings[resource.ResourceLogicalSlug]
		if resourceID == "" || !validTemplateEnv(resource.Name, seen) || !templateEnvironmentName.MatchString(resource.SecretKey) {
			return templateSnapshotRefs{}, true, ErrTemplateRuntimeSnapshot
		}
		refs.resources = append(refs.resources, templateResourceRef{resource.Name, resource.ResourceLogicalSlug, resource.SecretKey, resourceID})
	}
	return refs, true, nil
}

func validateTemplateSecretEnvironment(raw json.RawMessage, environmentID, kind string) error {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if kind == string(EnvironmentKindProd) {
			return nil
		}
		return ErrTemplateRuntimeScope
	}
	var metadata struct {
		EnvironmentID string `json:"environmentId"`
	}
	if json.Unmarshal(raw, &metadata) != nil || metadata.EnvironmentID != environmentID {
		return ErrTemplateRuntimeScope
	}
	return nil
}

func OpenTemplateSealedSecret(sealed string) ([]byte, error) {
	key := os.Getenv("ENCRYPTION_KEY")
	if key == "" {
		key = os.Getenv("RAIBITSERVER_SECRET_ENCRYPTION_KEY")
	}
	if len(key) < 32 {
		return nil, ErrTemplateRuntimeKey
	}
	if len(sealed) > maxTemplateSealedValue {
		return nil, ErrTemplateRuntimeSecret
	}
	parts := strings.Split(sealed, ":")
	if len(parts) != 5 || parts[0] != "aes256gcm" || parts[1] != "v1" {
		return nil, ErrTemplateRuntimeSecret
	}
	decode := base64.RawURLEncoding.DecodeString
	iv, ivErr := decode(parts[2])
	tag, tagErr := decode(parts[3])
	ciphertext, ciphertextErr := decode(parts[4])
	if ivErr != nil || tagErr != nil || ciphertextErr != nil || len(iv) != 12 || len(tag) != 16 {
		return nil, ErrTemplateRuntimeSecret
	}
	digest := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, ErrTemplateRuntimeSecret
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrTemplateRuntimeSecret
	}
	opened, err := gcm.Open(nil, iv, append(ciphertext, tag...), nil)
	if err != nil {
		return nil, ErrTemplateRuntimeSecret
	}
	return opened, nil
}

func validTemplateEnv(name string, seen map[string]bool) bool {
	valid := templateEnvironmentName.MatchString(name) && !seen[name]
	seen[name] = true
	return valid
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
