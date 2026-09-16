package store

import (
	"context"
	"time"
)

const (
	StatusProvisioning    = "PROVISIONING"
	StatusReconciling     = "RECONCILING"
	StatusReady           = "READY"
	StatusFailed          = "FAILED"
	StatusDeleteRequested = "DELETE_REQUESTED"
	StatusDeleting        = "DELETING"
	StatusDeleted         = "DELETED"
)

type Resource struct {
	ID                   string
	ProjectID            string
	OrganizationID       string
	ProjectSlug          string
	Name                 string
	Slug                 string
	Type                 string
	Engine               string
	Provider             string
	Plan                 string
	Region               string
	Version              string
	VersionPresent       bool
	Status               string
	ConnectionSecretName string
	ClaimToken           string
	DesiredSpec          map[string]any
	DesiredState         map[string]any
}

type Store interface {
	ClaimNextResourceDeletion(ctx context.Context, staleAfter, dryRunRecheck time.Duration) (*Resource, error)
	ClaimNextResource(ctx context.Context, staleAfter, dryRunRecheck time.Duration) (*Resource, error)
	ClaimNextReadyResource(ctx context.Context, revalidateAfter time.Duration) (*Resource, error)
	RenewResourceClaim(ctx context.Context, resource *Resource) error
	PersistProviderIdentity(ctx context.Context, resource *Resource, namespace, name string) error
	ReserveCredentialSecretGeneration(ctx context.Context, resource *Resource, generation string) error
	PersistCredentialSecretUID(ctx context.Context, resource *Resource, uid string) error
	TransitionResource(ctx context.Context, resource *Resource, expectedStatus, nextStatus string, desiredState map[string]any) error
	MarkResourceReady(ctx context.Context, resource *Resource, provider, secretName, endpoint string, secretKeys []string, desiredState map[string]any) error
	FinalizeResourceDeletion(ctx context.Context, resource *Resource) error
}
