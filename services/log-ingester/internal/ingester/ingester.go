package ingester

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
)

type Ingester struct {
	config Config
	source Source
	store  Store
}

func (i *Ingester) RunOnce(ctx context.Context, now time.Time) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, i.config.MaxRunDuration)
	defer cancel()
	result := Result{}
	started := i.config.Clock()
	if i.source == nil || i.store == nil {
		return result, ErrConfiguration
	}
	targets := []logTarget{}
	continuation := ""
	for seen := 0; seen < i.config.MaxPods; {
		limit := min(i.config.PageSize, i.config.MaxPods-seen)
		pods, next, err := i.source.ListPods(ctx, continuation, limit)
		if err != nil {
			return result, err
		}
		if len(pods) > limit {
			pods = pods[:limit]
		}
		seen += len(pods)
		for _, pod := range pods {
			if pod.UID == "" || pod.Labels[deploymentLabel] == "" {
				continue
			}
			scope, err := i.store.Resolve(ctx, pod.Labels[deploymentLabel])
			if errors.Is(err, identity.ErrLegacy) {
				result.LegacyRejected++
				continue
			}
			if errors.Is(err, identity.ErrIdentity) {
				result.IdentityRejected++
				continue
			}
			if err != nil {
				return result, err
			}
			if pod.Labels[serviceLabel] != scope.ServiceID {
				result.IdentityRejected++
				continue
			}
			created, err := i.source.Verify(ctx, pod, scope)
			if skipped(err) {
				result.IdentityRejected++
				continue
			}
			if err != nil {
				return result, err
			}
			result.Pods++
			containers := append([]string(nil), pod.Containers...)
			sort.Strings(containers)
			for _, container := range containers[:min(len(containers), i.config.MaxContainersPerPod)] {
				if container == scope.Container {
					targets = append(targets, logTarget{pod: pod, scope: scope, container: container, created: created})
				}
			}
		}
		if next == "" || next == continuation || len(pods) == 0 {
			break
		}
		continuation = next
	}
	if len(targets) > 1 {
		offset := int(uint64(now.UnixNano()) % uint64(len(targets)))
		targets = append(append(make([]logTarget, 0, len(targets)), targets[offset:]...), targets[:offset]...)
	}
	budget := runBudget{records: i.config.MaxRecordsPerRun, bytes: i.config.MaxBytesPerRun, perTarget: min(i.config.MaxLinesPerContainer, max(1, (i.config.MaxRecordsPerRun+len(targets)-1)/max(1, len(targets))))}
	records := []Record{}
	cursors := []CursorUpdate{}
	for _, target := range targets {
		if budget.records <= 0 || budget.bytes <= 0 {
			break
		}
		batch, update, limited, err := i.collect(ctx, target, collection{now: now, budget: budget})
		if skipped(err) {
			result.IdentityRejected++
			continue
		}
		if err != nil {
			return result, err
		}
		result.Containers++
		result.SourceWindowLimited = result.SourceWindowLimited || limited
		if update.Key == "" {
			continue
		}
		for _, row := range batch {
			budget.bytes -= int64(len(row.Line))
		}
		budget.records -= len(batch)
		records = append(records, batch...)
		cursors = append(cursors, update)
	}
	inserted, err := i.store.Insert(ctx, records, cursors)
	if err != nil {
		return result, err
	}
	result.Inserted = inserted
	if inserted > 0 {
		result.Observed = true
		result.ObservedAt = now.Add(i.config.Clock().Sub(started))
		for _, record := range records {
			result.LagSeconds = max(result.LagSeconds, max(0, result.ObservedAt.Sub(record.Timestamp).Seconds()))
		}
	}
	deleted, err := i.store.DeleteOlderThan(ctx, now.Add(-i.config.Retention))
	result.Deleted = deleted
	return result, err
}

func skipped(err error) bool {
	if errors.Is(err, identity.ErrIdentity) {
		return true
	}
	var status interface{ SkipContainer() bool }
	return errors.As(err, &status) && status.SkipContainer()
}
