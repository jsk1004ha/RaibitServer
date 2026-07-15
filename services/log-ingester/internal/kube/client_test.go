package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/raibitserver/log-ingester/internal/ingester"
)

func TestClientReloadsProjectedServiceAccountToken(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("first-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		want := "Bearer first-token"
		if requests == 2 {
			want = "Bearer second-token"
		}
		if got := request.Header.Get("Authorization"); got != want {
			t.Errorf("request %d authorization=%q want %q", requests, got, want)
		}
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, `{"metadata":{},"items":[]}`)
	}))
	defer server.Close()
	t.Setenv("RAIBITSERVER_KUBERNETES_API", server.URL)
	t.Setenv("RAIBITSERVER_KUBERNETES_TOKEN", "")
	t.Setenv("RAIBITSERVER_KUBERNETES_TOKEN_FILE", tokenPath)
	client, err := NewFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ListPods(context.Background(), "", 1); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("second-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.ListPods(context.Background(), "", 1); err != nil {
		t.Fatal(err)
	}
}

func TestReadLogsConsumesOversizedLinesAndRejectsPartialTrailingRecords(t *testing.T) {
	at := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(at.Format(time.RFC3339Nano) + " " + strings.Repeat("x", 70*1024)))
		_, _ = response.Write([]byte{0xff, '\n'})
		_, _ = response.Write([]byte(at.Add(time.Second).Format(time.RFC3339Nano) + " partial-without-newline"))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, staticToken: "test-token", http: server.Client()}
	entries, err := client.ReadLogs(context.Background(), ingester.Pod{Namespace: "ns", Name: "pod"}, "app", time.Time{}, 256*1024)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one complete log record, got %#v", entries)
	}
	if !entries[0].Timestamp.Equal(at) || !utf8.ValidString(entries[0].Line) || len(entries[0].Line) > 64*1024 {
		t.Fatalf("oversized/invalid log was not safely bounded: timestamp=%s bytes=%d valid=%v", entries[0].Timestamp, len(entries[0].Line), utf8.ValidString(entries[0].Line))
	}
}

func TestReadLogsClassifiesGonePodAsSkippable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "pod disappeared", http.StatusGone)
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, staticToken: "test-token", http: server.Client()}
	_, err := client.ReadLogs(context.Background(), ingester.Pod{Namespace: "ns", Name: "pod"}, "app", time.Time{}, 1024)
	if err == nil {
		t.Fatal("expected Kubernetes status error")
	}
	status, ok := err.(*StatusError)
	if !ok || !status.SkipContainer() {
		t.Fatalf("gone pod was not classified as skippable: %T %v", err, err)
	}
}
