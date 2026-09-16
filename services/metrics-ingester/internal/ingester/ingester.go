package ingester

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/raibitserver/metrics-ingester/internal/identity"
)

const (
	serviceLabel    = "raibitserver.io/service-id"
	deploymentLabel = "raibitserver.io/deployment-id"
)

type Config struct {
	PageSize            int
	MaxPods             int
	MaxContainersPerPod int
	MaxSamplesPerRun    int
	MaxRunDuration      time.Duration
	Retention           time.Duration
	MaxBytesPerRun      int
	Now                 func() time.Time
}

type ContainerMetrics struct {
	Name   string
	CPU    string
	Memory string
}

type PodMetrics struct {
	Namespace  string
	Name       string
	UID        string
	Labels     map[string]string
	Timestamp  time.Time
	Containers []ContainerMetrics
}

type Record struct {
	Scope         identity.Scope
	Namespace     string
	SourceKey     string
	ServiceID     string
	DeploymentID  string
	PodName       string
	PodUID        string
	ContainerName string
	Metric        string
	Value         float64
	Unit          string
	Timestamp     time.Time
}

type Source interface {
	ListPodMetrics(ctx context.Context, continueToken string, limit int) ([]PodMetrics, string, error)
}

type Store interface {
	Resolve(ctx context.Context, deploymentID string) (identity.Scope, error)
	Insert(ctx context.Context, batch Batch) (Persisted, error)
	DeleteOlderThan(ctx context.Context, before time.Time) (int64, error)
}

type Result struct {
	Pods       int
	Samples    int
	Inserted   int
	Deleted    int64
	Observed   bool
	LagSeconds float64
}

type (
	Batch struct {
		Records []Record
		Limit   int
		Now     time.Time
	}
	Persisted struct {
		Inserted int
		Newest   time.Time
	}
	VerifiedPod struct {
		UID       string
		CreatedAt time.Time
	}
	IdentitySource interface {
		Verify(context.Context, PodMetrics, identity.Scope) (VerifiedPod, error)
	}
)

type Ingester struct {
	config Config
	source Source
	store  Store
}

func New(config Config, source Source, store Store) *Ingester {
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.PageSize <= 0 || config.PageSize > 500 {
		config.PageSize = 100
	}
	if config.MaxPods <= 0 || config.MaxPods > 5000 {
		config.MaxPods = 500
	}
	if config.MaxContainersPerPod <= 0 || config.MaxContainersPerPod > 32 {
		config.MaxContainersPerPod = 8
	}
	if config.MaxSamplesPerRun <= 0 || config.MaxSamplesPerRun > 50000 {
		config.MaxSamplesPerRun = 10000
	}
	if config.MaxRunDuration <= 0 || config.MaxRunDuration > 2*time.Minute {
		config.MaxRunDuration = 20 * time.Second
	}
	if config.MaxBytesPerRun <= 0 || config.MaxBytesPerRun > 16*1024*1024 {
		config.MaxBytesPerRun = 16 * 1024 * 1024
	}
	if config.Retention <= 0 || config.Retention > 30*24*time.Hour {
		config.Retention = 30 * 24 * time.Hour
	}
	return &Ingester{config: config, source: source, store: store}
}

func (i *Ingester) RunOnce(ctx context.Context, now time.Time) (Result, error) {
	if i.source == nil || i.store == nil {
		return Result{}, fmt.Errorf("metrics ingester source and store are required")
	}
	now = now.UTC()
	ctx, cancel := context.WithTimeout(ctx, i.config.MaxRunDuration)
	defer cancel()
	ctx = WithByteBudget(ctx, i.config.MaxBytesPerRun)
	verifier, ok := i.source.(IdentitySource)
	if !ok {
		return Result{}, identity.ErrIdentity
	}
	result := Result{}
	continueToken := ""
	seenPods := 0
	podMetrics := make([]PodMetrics, 0)
	for seenPods < i.config.MaxPods {
		limit := min(i.config.PageSize, i.config.MaxPods-seenPods)
		pods, next, err := i.source.ListPodMetrics(ctx, continueToken, limit)
		if err != nil {
			return result, fmt.Errorf("list Kubernetes pod metrics: %w", err)
		}
		if len(pods) > limit {
			pods = pods[:limit]
		}
		seenPods += len(pods)
		podMetrics = append(podMetrics, pods...)
		if next == "" || len(pods) == 0 || seenPods >= i.config.MaxPods {
			break
		}
		continueToken = next
	}
	if len(podMetrics) > 1 {
		offset := int(now.UnixNano() % int64(len(podMetrics)))
		podMetrics = append(append(make([]PodMetrics, 0, len(podMetrics)), podMetrics[offset:]...), podMetrics[:offset]...)
	}
	perPodContainers := min(i.config.MaxContainersPerPod, max(1, (i.config.MaxSamplesPerRun+2*max(1, len(podMetrics))-1)/(2*max(1, len(podMetrics)))))
	pendingRecords := make([]Record, 0, min(i.config.MaxSamplesPerRun, 1000))
	for _, pod := range podMetrics {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if pod.Timestamp.IsZero() || pod.Timestamp.After(now.Add(30*time.Second)) || pod.Timestamp.Before(now.Add(-i.config.Retention)) {
			continue
		}
		scope, resolveErr := i.store.Resolve(ctx, pod.Labels[deploymentLabel])
		if resolveErr != nil {
			if errors.Is(resolveErr, identity.ErrIdentity) {
				continue
			}
			return result, &Failure{Code: "database"}
		}
		verified, verifyErr := verifier.Verify(ctx, pod, scope)
		if verifyErr != nil {
			if errors.Is(verifyErr, identity.ErrIdentity) {
				continue
			}
			return result, verifyErr
		}
		if pod.Timestamp.Before(verified.CreatedAt) || verified.UID == "" {
			continue
		}
		pod.UID = verified.UID
		result.Pods++
		containers := append([]ContainerMetrics(nil), pod.Containers...)
		sort.Slice(containers, func(a, b int) bool { return containers[a].Name < containers[b].Name })
		if len(containers) > perPodContainers {
			containers = containers[:perPodContainers]
		}
		records := make([]Record, 0, len(containers)*2)
		for _, container := range containers {
			cpu, cpuErr := ParseQuantity(container.CPU)
			memory, memoryErr := ParseQuantity(container.Memory)
			if cpuErr != nil || memoryErr != nil || cpu < 0 || memory < 0 {
				continue
			}
			if container.Name != scope.ContainerName {
				continue
			}
			base := Record{Scope: scope, Namespace: pod.Namespace, ServiceID: scope.ServiceID, DeploymentID: scope.DeploymentID, PodName: pod.Name, PodUID: pod.UID, ContainerName: container.Name, Timestamp: pod.Timestamp.UTC()}
			cpuRecord := base
			cpuRecord.Metric, cpuRecord.Value, cpuRecord.Unit = "cpu", cpu, "cores"
			cpuRecord.SourceKey = sourceKey(pod, container.Name, "cpu")
			memoryRecord := base
			memoryRecord.Metric, memoryRecord.Value, memoryRecord.Unit = "memory", memory, "bytes"
			memoryRecord.SourceKey = sourceKey(pod, container.Name, "memory")
			records = append(records, cpuRecord, memoryRecord)
		}
		pendingRecords = append(pendingRecords, records...)
		result.Samples += len(records)
	}
	persisted, err := i.store.Insert(ctx, Batch{Records: pendingRecords, Limit: i.config.MaxSamplesPerRun, Now: now})
	if err != nil {
		return result, fmt.Errorf("persist runtime metrics: %w", err)
	}
	result.Inserted = persisted.Inserted
	result.Samples = persisted.Inserted
	result.Observed = !persisted.Newest.IsZero()
	if result.Observed {
		result.LagSeconds = max(0, i.config.Now().Sub(persisted.Newest).Seconds())
	}
	deleted, err := i.store.DeleteOlderThan(ctx, now.Add(-i.config.Retention))
	if err != nil {
		return result, fmt.Errorf("enforce runtime-metric retention: %w", err)
	}
	result.Deleted = deleted
	return result, nil
}

func sourceKey(pod PodMetrics, container, metric string) string {
	digest := sha256.Sum256([]byte(pod.UID + "\x00" + pod.Namespace + "\x00" + pod.Name + "\x00" + container + "\x00" + metric + "\x00" + pod.Timestamp.UTC().Format(time.RFC3339Nano)))
	return hex.EncodeToString(digest[:])
}
