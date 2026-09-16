package ingester

import (
	"context"
	"errors"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
)

const (
	serviceLabel    = "raibitserver.io/service-id"
	deploymentLabel = "raibitserver.io/deployment-id"
)

var (
	ErrConfiguration       = errors.New("log ingester source and store are required")
	ErrSourceWindowLimited = errors.New("source_window_limited")
	ErrCursorConflict      = errors.New("source cursor changed concurrently")
)

type Config struct {
	Clock                                                                                        func() time.Time
	PageSize, MaxPods, MaxContainersPerPod, MaxLinesPerContainer, MaxLineBytes, MaxRecordsPerRun int
	MaxReadBytes, MaxBytesPerRun                                                                 int64
	MaxRunDuration, Retention                                                                    time.Duration
}
type (
	Pod struct {
		Namespace, Name, UID string
		Labels               map[string]string
		Containers           []string
	}
	LogEntry struct {
		Timestamp      time.Time
		Line           string
		RedactionInput string
	}
	Record struct {
		Scope                                                                           identity.Scope
		SourceKey, ServiceID, DeploymentID, PodName, PodUID, ContainerName, Line, Level string
		Timestamp                                                                       time.Time
	}
)

type CursorUpdate struct {
	Scope                identity.Scope
	Key                  string
	Cursor               time.Time
	ExpectedState, State string
}
type Source interface {
	ListPods(context.Context, string, int) ([]Pod, string, error)
	Verify(context.Context, Pod, identity.Scope) (time.Time, error)
	ReadLogs(context.Context, Pod, string, time.Time, int64) ([]LogEntry, error)
}
type Store interface {
	Resolve(context.Context, string) (identity.Scope, error)
	Cursor(context.Context, string) (time.Time, error)
	State(context.Context, string) (string, error)
	Existing(context.Context, []string) (map[string]bool, error)
	Insert(context.Context, []Record, []CursorUpdate) (int, error)
	DeleteOlderThan(context.Context, time.Time) (int64, error)
}
type Result struct {
	ObservedAt                                                   time.Time
	Pods, Containers, Inserted, IdentityRejected, LegacyRejected int
	Deleted                                                      int64
	SourceWindowLimited, Observed                                bool
	LagSeconds                                                   float64
}
type (
	logTarget struct {
		pod       Pod
		scope     identity.Scope
		container string
		created   time.Time
	}
	runBudget struct {
		records, perTarget int
		bytes              int64
	}
	collection struct {
		now    time.Time
		budget runBudget
	}
)

func New(config Config, source Source, store Store) *Ingester {
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.PageSize <= 0 || config.PageSize > 500 {
		config.PageSize = 100
	}
	if config.MaxPods <= 0 || config.MaxPods > 200 {
		config.MaxPods = 200
	}
	if config.MaxContainersPerPod <= 0 || config.MaxContainersPerPod > 32 {
		config.MaxContainersPerPod = 8
	}
	if config.MaxLinesPerContainer <= 0 || config.MaxLinesPerContainer > 10000 {
		config.MaxLinesPerContainer = 1000
	}
	if config.MaxLineBytes <= 0 || config.MaxLineBytes > 16384 {
		config.MaxLineBytes = 16384
	}
	if config.MaxReadBytes <= 0 || config.MaxReadBytes > 1048576 {
		config.MaxReadBytes = 1048576
	}
	if config.MaxRecordsPerRun <= 0 || config.MaxRecordsPerRun > 10000 {
		config.MaxRecordsPerRun = 10000
	}
	if config.MaxBytesPerRun <= 0 || config.MaxBytesPerRun > 16777216 {
		config.MaxBytesPerRun = 16777216
	}
	if config.MaxBytesPerRun < int64(config.MaxLineBytes) {
		config.MaxBytesPerRun = int64(config.MaxLineBytes)
	}
	if config.MaxRunDuration <= 0 || config.MaxRunDuration > 2*time.Minute {
		config.MaxRunDuration = 20 * time.Second
	}
	if config.Retention <= 0 || config.Retention > 7*24*time.Hour {
		config.Retention = 7 * 24 * time.Hour
	}
	return &Ingester{config: config, source: source, store: store}
}
