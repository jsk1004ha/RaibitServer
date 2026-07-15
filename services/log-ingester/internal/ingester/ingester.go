package ingester

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	serviceLabel    = "raibitserver.io/service-id"
	deploymentLabel = "raibitserver.io/deployment-id"
)

type Config struct {
	PageSize             int
	MaxPods              int
	MaxContainersPerPod  int
	MaxLinesPerContainer int
	MaxLineBytes         int
	MaxReadBytes         int64
	MaxRecordsPerRun     int
	MaxBytesPerRun       int64
	MaxRunDuration       time.Duration
	Retention            time.Duration
}

type Pod struct {
	Namespace  string
	Name       string
	UID        string
	Labels     map[string]string
	Containers []string
}

type LogEntry struct {
	Timestamp time.Time
	Line      string
}

type Record struct {
	SourceKey     string
	ServiceID     string
	DeploymentID  string
	PodName       string
	PodUID        string
	ContainerName string
	Line          string
	Level         string
	Timestamp     time.Time
}

type CursorUpdate struct {
	Key    string
	Cursor time.Time
}

type Source interface {
	ListPods(ctx context.Context, continueToken string, limit int) ([]Pod, string, error)
	ReadLogs(ctx context.Context, pod Pod, container string, since time.Time, limitBytes int64) ([]LogEntry, error)
}

type Store interface {
	Cursor(ctx context.Context, key string) (time.Time, error)
	Insert(ctx context.Context, records []Record, cursors []CursorUpdate) (int, error)
	DeleteOlderThan(ctx context.Context, before time.Time) (int64, error)
}

type Result struct {
	Pods       int
	Containers int
	Inserted   int
	Deleted    int64
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
	if config.MaxPods <= 0 || config.MaxPods > 2000 {
		config.MaxPods = 200
	}
	if config.MaxContainersPerPod <= 0 || config.MaxContainersPerPod > 32 {
		config.MaxContainersPerPod = 8
	}
	if config.MaxLinesPerContainer <= 0 || config.MaxLinesPerContainer > 10000 {
		config.MaxLinesPerContainer = 1000
	}
	if config.MaxLineBytes <= 0 || config.MaxLineBytes > 64*1024 {
		config.MaxLineBytes = 16 * 1024
	}
	if config.MaxReadBytes <= 0 || config.MaxReadBytes > 10*1024*1024 {
		config.MaxReadBytes = 1024 * 1024
	}
	if config.MaxRecordsPerRun <= 0 || config.MaxRecordsPerRun > 50000 {
		config.MaxRecordsPerRun = 10000
	}
	if config.MaxBytesPerRun <= 0 || config.MaxBytesPerRun > 64*1024*1024 {
		config.MaxBytesPerRun = 16 * 1024 * 1024
	}
	if config.MaxBytesPerRun < int64(config.MaxLineBytes) {
		config.MaxBytesPerRun = int64(config.MaxLineBytes)
	}
	if config.MaxRunDuration <= 0 || config.MaxRunDuration > 2*time.Minute {
		config.MaxRunDuration = 20 * time.Second
	}
	if config.Retention <= 0 {
		config.Retention = 7 * 24 * time.Hour
	}
	return &Ingester{config: config, source: source, store: store}
}

func (i *Ingester) RunOnce(ctx context.Context, now time.Time) (Result, error) {
	if i.source == nil || i.store == nil {
		return Result{}, fmt.Errorf("log ingester source and store are required")
	}
	now = now.UTC()
	result := Result{}
	started := time.Now()
	continueToken := ""
	seenPods := 0
	targets := make([]logTarget, 0)
	for seenPods < i.config.MaxPods {
		limit := min(i.config.PageSize, i.config.MaxPods-seenPods)
		pods, next, err := i.source.ListPods(ctx, continueToken, limit)
		if err != nil {
			return result, fmt.Errorf("list workload pods: %w", err)
		}
		if len(pods) > limit {
			pods = pods[:limit]
		}
		seenPods += len(pods)
		for _, pod := range pods {
			serviceID := strings.TrimSpace(pod.Labels[serviceLabel])
			if serviceID == "" || strings.TrimSpace(pod.UID) == "" {
				continue
			}
			result.Pods++
			containers := append([]string(nil), pod.Containers...)
			sort.Strings(containers)
			if len(containers) > i.config.MaxContainersPerPod {
				containers = containers[:i.config.MaxContainersPerPod]
			}
			for _, container := range containers {
				if strings.TrimSpace(container) == "" {
					continue
				}
				targets = append(targets, logTarget{pod: pod, serviceID: serviceID, container: container})
			}
		}
		if next == "" || len(pods) == 0 || seenPods >= i.config.MaxPods {
			break
		}
		continueToken = next
	}
	if len(targets) > 1 {
		offset := int(now.UnixNano() % int64(len(targets)))
		targets = append(append(make([]logTarget, 0, len(targets)), targets[offset:]...), targets[:offset]...)
	}
	perTargetRecords := min(i.config.MaxLinesPerContainer, max(1, (i.config.MaxRecordsPerRun+len(targets)-1)/max(1, len(targets))))
	perTargetBytes := max(int64(i.config.MaxLineBytes), (i.config.MaxBytesPerRun+int64(max(1, len(targets)))-1)/int64(max(1, len(targets))))
	recordsUsed := 0
	bytesUsed := int64(0)
	pendingRecords := make([]Record, 0, min(i.config.MaxRecordsPerRun, 1000))
	pendingCursors := make([]CursorUpdate, 0, len(targets))
	for _, target := range targets {
		if recordsUsed >= i.config.MaxRecordsPerRun || bytesUsed >= i.config.MaxBytesPerRun || time.Since(started) >= i.config.MaxRunDuration {
			break
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		result.Containers++
		cursorKey := "logs:" + target.pod.UID + ":" + target.container
		since, err := i.store.Cursor(ctx, cursorKey)
		if err != nil {
			return result, fmt.Errorf("read %s cursor: %w", cursorKey, err)
		}
		if since.IsZero() {
			since = now.Add(-i.config.Retention)
		}
		entries, err := i.source.ReadLogs(ctx, target.pod, target.container, since, i.config.MaxReadBytes)
		if err != nil {
			var skippable interface{ SkipContainer() bool }
			if errors.As(err, &skippable) && skippable.SkipContainer() {
				continue
			}
			return result, fmt.Errorf("read logs for %s/%s[%s]: %w", target.pod.Namespace, target.pod.Name, target.container, err)
		}
		if len(entries) > perTargetRecords {
			entries = entries[:perTargetRecords]
		}
		records := make([]Record, 0, len(entries))
		nextCursor := since
		targetBytes := int64(0)
		for _, entry := range entries {
			at := entry.Timestamp.UTC()
			if at.IsZero() || at.Before(since) {
				continue
			}
			line := boundedLine(redact(entry.Line), i.config.MaxLineBytes)
			lineBytes := int64(len([]byte(line)))
			if line == "" || recordsUsed+len(records) >= i.config.MaxRecordsPerRun || bytesUsed+targetBytes+lineBytes > i.config.MaxBytesPerRun || (len(records) > 0 && targetBytes+lineBytes > perTargetBytes) {
				break
			}
			records = append(records, Record{
				SourceKey: sourceKey(target.pod.UID, target.container, at, entry.Line), ServiceID: target.serviceID,
				DeploymentID: strings.TrimSpace(target.pod.Labels[deploymentLabel]), PodName: target.pod.Name, PodUID: target.pod.UID,
				ContainerName: target.container, Line: line, Level: levelFor(line), Timestamp: at,
			})
			targetBytes += lineBytes
			if at.After(nextCursor) {
				nextCursor = at
			}
		}
		pendingRecords = append(pendingRecords, records...)
		pendingCursors = append(pendingCursors, CursorUpdate{Key: cursorKey, Cursor: nextCursor})
		recordsUsed += len(records)
		bytesUsed += targetBytes
	}
	inserted, err := i.store.Insert(ctx, pendingRecords, pendingCursors)
	if err != nil {
		return result, fmt.Errorf("persist logs and cursors: %w", err)
	}
	result.Inserted = inserted
	deleted, err := i.store.DeleteOlderThan(ctx, now.Add(-i.config.Retention))
	if err != nil {
		return result, fmt.Errorf("enforce runtime-log retention: %w", err)
	}
	result.Deleted = deleted
	return result, nil
}

type logTarget struct {
	pod       Pod
	serviceID string
	container string
}

func sourceKey(podUID, container string, timestamp time.Time, line string) string {
	digest := sha256.Sum256([]byte(podUID + "\x00" + container + "\x00" + timestamp.UTC().Format(time.RFC3339Nano) + "\x00" + line))
	return hex.EncodeToString(digest[:])
}

func boundedLine(value string, maxBytes int) string {
	value = strings.TrimRight(value, "\r\n")
	bytes := []byte(value)
	if len(bytes) <= maxBytes {
		return value
	}
	return strings.ToValidUTF8(string(bytes[:maxBytes]), "")
}

func levelFor(line string) string {
	lower := strings.ToLower(line)
	if strings.Contains(lower, "error") || strings.Contains(lower, "fatal") || strings.Contains(lower, "panic") {
		return "error"
	}
	if strings.Contains(lower, "warn") {
		return "warn"
	}
	return "info"
}

var (
	assignmentSecretPattern   = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|database_url|mongodb_uri|redis_url)\s*[=:]\s*([^\s,;]+)`)
	credentialURLPattern      = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@]+@`)
	knownTokenPattern         = regexp.MustCompile(`(?i)\b(ghp_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_-]+`)
	doubleQuotedSecretPattern = regexp.MustCompile(`(?i)("(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url)"\s*:\s*")(?:\\.|[^"\\])*(")`)
	singleQuotedSecretPattern = regexp.MustCompile(`(?i)('(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url)'\s*:\s*')(?:\\.|[^'\\])*(')`)
	authorizationPattern      = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+`)
	cookiePattern             = regexp.MustCompile(`(?i)((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+`)
	jwtPattern                = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	privateKeyPattern         = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
)

func redact(value string) string {
	value = privateKeyPattern.ReplaceAllString(value, "[REDACTED PRIVATE KEY]")
	value = credentialURLPattern.ReplaceAllString(value, `$1****@`)
	value = doubleQuotedSecretPattern.ReplaceAllString(value, `$1****$2`)
	value = singleQuotedSecretPattern.ReplaceAllString(value, `$1****$2`)
	value = authorizationPattern.ReplaceAllString(value, `$1****`)
	value = cookiePattern.ReplaceAllString(value, `$1****`)
	value = jwtPattern.ReplaceAllString(value, "[REDACTED JWT]")
	value = assignmentSecretPattern.ReplaceAllString(value, `$1=****`)
	return knownTokenPattern.ReplaceAllString(value, `$1****`)
}
