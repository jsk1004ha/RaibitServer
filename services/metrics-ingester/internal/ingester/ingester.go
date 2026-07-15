package ingester

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
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
	Insert(ctx context.Context, records []Record) (int, error)
	DeleteOlderThan(ctx context.Context, before time.Time) (int64, error)
}

type Result struct {
	Pods     int
	Samples  int
	Inserted int
	Deleted  int64
}

type Ingester struct {
	config Config
	source Source
	store  Store
}

func New(config Config, source Source, store Store) *Ingester {
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
	if config.Retention <= 0 {
		config.Retention = 30 * 24 * time.Hour
	}
	return &Ingester{config: config, source: source, store: store}
}

func (i *Ingester) RunOnce(ctx context.Context, now time.Time) (Result, error) {
	if i.source == nil || i.store == nil {
		return Result{}, fmt.Errorf("metrics ingester source and store are required")
	}
	now = now.UTC()
	result := Result{}
	started := time.Now()
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
		if result.Samples+2 > i.config.MaxSamplesPerRun || time.Since(started) >= i.config.MaxRunDuration {
			break
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		serviceID := strings.TrimSpace(pod.Labels[serviceLabel])
		if serviceID == "" || pod.Timestamp.IsZero() {
			continue
		}
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
			base := Record{ServiceID: serviceID, DeploymentID: strings.TrimSpace(pod.Labels[deploymentLabel]), PodName: pod.Name, PodUID: pod.UID, ContainerName: container.Name, Timestamp: pod.Timestamp.UTC()}
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
	inserted, err := i.store.Insert(ctx, pendingRecords)
	if err != nil {
		return result, fmt.Errorf("persist runtime metrics: %w", err)
	}
	result.Inserted = inserted
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

var quantityPattern = regexp.MustCompile(`^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))([numkKMGTPE]i?|[eE][+-]?[0-9]+)?$`)

func ParseQuantity(value string) (float64, error) {
	match := quantityPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, fmt.Errorf("invalid Kubernetes quantity %q", value)
	}
	number, err := strconv.ParseFloat(match[1], 64)
	if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
		return 0, fmt.Errorf("invalid Kubernetes quantity %q", value)
	}
	suffix := match[2]
	multipliers := map[string]float64{
		"": 1, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "K": 1e3,
		"M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
		"Ki": 1024, "Mi": 1024 * 1024, "Gi": 1024 * 1024 * 1024,
		"Ti": math.Pow(1024, 4), "Pi": math.Pow(1024, 5), "Ei": math.Pow(1024, 6),
	}
	multiplier, ok := multipliers[suffix]
	if !ok && (strings.HasPrefix(suffix, "e") || strings.HasPrefix(suffix, "E")) {
		exponent, parseErr := strconv.Atoi(suffix[1:])
		if parseErr == nil {
			multiplier, ok = math.Pow10(exponent), true
		}
	}
	if !ok {
		return 0, fmt.Errorf("unsupported Kubernetes quantity suffix %q", suffix)
	}
	result := number * multiplier
	if math.IsInf(result, 0) || math.IsNaN(result) {
		return 0, fmt.Errorf("Kubernetes quantity %q overflows", value)
	}
	return result, nil
}
