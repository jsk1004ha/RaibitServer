package providers

import "context"

type ResourceSpec struct {
	ID      string
	Name    string
	Engine  string
	Plan    string
	Region  string
	Storage int
}

type ResourceStatus struct {
	ID       string
	Endpoint string
	Ready    bool
}

type Credentials struct {
	Username string
	Password string
	URI      string
}

type Backup struct {
	ID         string
	ResourceID string
	Status     string
}

type ResourceProvider interface {
	Create(ctx context.Context, spec ResourceSpec) (*ResourceStatus, error)
	Delete(ctx context.Context, id string) error
	GetStatus(ctx context.Context, id string) (*ResourceStatus, error)
	RotateCredentials(ctx context.Context, id string) (*Credentials, error)
	CreateBackup(ctx context.Context, id string) (*Backup, error)
	RestoreBackup(ctx context.Context, backupID string) error
}

func DefaultCatalog() map[string]string {
	return map[string]string{
		"postgresql":     "CloudNativePG",
		"sqlite":         "PVC-backed file provider",
		"mysql":          "Percona Operator",
		"mariadb":        "MariaDB Operator",
		"mongodb":        "MongoDB/Atlas Operator",
		"redis":          "Redis Operator/Upstash adapter",
		"valkey":         "Valkey/Redis-compatible adapter",
		"object-storage": "MinIO/S3 adapter",
		"qdrant":         "Qdrant local/provider adapter",
		"vector-db":      "Qdrant/Weaviate/Milvus adapter",
		"nats":           "NATS local/provider adapter",
		"message-queue":  "NATS/Kafka/Redpanda/RabbitMQ adapter",
	}
}
