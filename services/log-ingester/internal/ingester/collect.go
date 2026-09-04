package ingester

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/raibitserver/log-ingester/internal/identity"
	"github.com/raibitserver/log-ingester/internal/redact"
)

func (i *Ingester) collect(ctx context.Context, target logTarget, input collection) ([]Record, CursorUpdate, bool, error) {
	key := "logs:" + target.pod.UID + ":" + target.container
	since, err := i.store.Cursor(ctx, key)
	if err != nil {
		return nil, CursorUpdate{}, false, err
	}
	since = maxTime(since, input.now.Add(-i.config.Retention))
	stateRaw, err := i.store.State(ctx, "logs-state:"+target.pod.UID+":"+target.container)
	if err != nil {
		return nil, CursorUpdate{}, false, err
	}
	state := redact.State{Version: 1}
	if stateRaw != "" && (len(stateRaw) > 256 || json.Unmarshal([]byte(stateRaw), &state) != nil || state.Version != 1 || (state.Quote != "" && state.Quote != "\"" && state.Quote != "'")) {
		return nil, CursorUpdate{}, false, ErrCursorConflict
	}
	entries, err := i.source.ReadLogs(ctx, target.pod, target.container, since, i.config.MaxReadBytes)
	limited := errors.Is(err, ErrSourceWindowLimited)
	if err != nil && !limited {
		return nil, CursorUpdate{}, false, err
	}
	// A Pod recreated between identity GET and its log GET cannot supply this batch.
	created, err := i.source.Verify(ctx, target.pod, target.scope)
	if err != nil {
		return nil, CursorUpdate{}, false, err
	}
	if !created.Equal(target.created) {
		return nil, CursorUpdate{}, false, identity.ErrIdentity
	}
	sort.SliceStable(entries, func(a, b int) bool { return entries[a].Timestamp.Before(entries[b].Timestamp) })
	keys := make([]string, len(entries))
	for index, entry := range entries {
		keys[index] = sourceKey(target.pod.UID, target.container, entry.Timestamp, entry.Line)
	}
	existing, err := i.store.Existing(ctx, keys)
	if err != nil {
		return nil, CursorUpdate{}, false, err
	}
	rows := []Record{}
	next := since
	used := int64(0)
	for index, entry := range entries {
		at := entry.Timestamp.UTC()
		if at.IsZero() || at.Before(since) || at.Before(target.created) || at.After(input.now.Add(30*time.Second)) {
			continue
		}
		if existing[keys[index]] {
			continue
		}
		inputLine := entry.Line
		if entry.RedactionInput != "" {
			inputLine = entry.RedactionInput
		}
		line, nextState := redact.Line(inputLine, state)
		line = boundedLine(line, i.config.MaxLineBytes)
		if len(rows) >= min(input.budget.records, input.budget.perTarget) || used+int64(len(line)) > input.budget.bytes {
			limited = true
			break
		}
		if line == "" {
			continue
		}
		existing[keys[index]] = true
		state = nextState
		state.Sequence++
		rows = append(rows, Record{Scope: target.scope, SourceKey: keys[index], ServiceID: target.scope.ServiceID, DeploymentID: target.scope.DeploymentID, PodName: target.pod.Name, PodUID: target.pod.UID, ContainerName: target.container, Line: line, Level: levelFor(line), Timestamp: at})
		next = maxTime(next, at)
		used += int64(len(line))
	}
	if len(rows) == 0 {
		return nil, CursorUpdate{}, limited, nil
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, CursorUpdate{}, false, err
	}
	return rows, CursorUpdate{Scope: target.scope, Key: key, Cursor: next, ExpectedState: stateRaw, State: string(encoded)}, limited, nil
}

// sourceKey is the stored v1 contract: original pre-redaction source line and nanoseconds.
func sourceKey(uid, container string, at time.Time, line string) string {
	hash := sha256.Sum256([]byte(uid + "\x00" + container + "\x00" + at.UTC().Format(time.RFC3339Nano) + "\x00" + line))
	return hex.EncodeToString(hash[:])
}

func boundedLine(value string, limit int) string {
	value = strings.TrimRight(value, "\r\n")
	if len(value) <= limit {
		return value
	}
	return strings.ToValidUTF8(value[:limit], "")
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

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
