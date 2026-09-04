package kube

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/raibitserver/log-ingester/internal/ingester"
)

func (c *Client) ReadLogs(ctx context.Context, pod ingester.Pod, container string, since time.Time, limitBytes int64) ([]ingester.LogEntry, error) {
	query := url.Values{"container": {container}, "timestamps": {"true"}, "limitBytes": {fmt.Sprint(limitBytes)}}
	if !since.IsZero() {
		query.Set("sinceTime", since.UTC().Format(time.RFC3339Nano))
	}
	path := "/api/v1/namespaces/" + url.PathEscape(pod.Namespace) + "/pods/" + url.PathEscape(pod.Name) + "/log?" + query.Encode()
	response, err := c.request(ctx, path)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	entries := []ingester.LogEntry{}
	remaining := limitBytes
	limited := false
	reader := bufio.NewReaderSize(io.LimitReader(response.Body, limitBytes+1), 64*1024)
	for {
		lineBytes, readErr := reader.ReadBytes('\n')
		remaining -= int64(len(lineBytes))
		if remaining <= 0 {
			limited = true
		}
		if len(lineBytes) > 0 && lineBytes[len(lineBytes)-1] != '\n' {
			limited = true
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, fmt.Errorf("read Kubernetes logs: %w", readErr)
		}
		if len(lineBytes) > 0 && lineBytes[len(lineBytes)-1] == '\n' {
			lineBytes = bytes.TrimSuffix(lineBytes, []byte{'\n'})
			lineBytes = bytes.TrimSuffix(lineBytes, []byte{'\r'})
			fullLine := strings.ReplaceAll(strings.ToValidUTF8(string(lineBytes), ""), "\x00", "")
			if len(lineBytes) > 64*1024 {
				lineBytes = lineBytes[:64*1024]
			}
			line := strings.ReplaceAll(strings.ToValidUTF8(string(lineBytes), ""), "\x00", "")
			separator := strings.IndexByte(line, ' ')
			if separator > 0 {
				at, parseErr := time.Parse(time.RFC3339Nano, line[:separator])
				if parseErr == nil {
					entries = append(entries, ingester.LogEntry{Timestamp: at, Line: line[separator+1:], RedactionInput: fullLine[separator+1:]})
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	if limited {
		return entries, ingester.ErrSourceWindowLimited
	}
	return entries, nil
}
