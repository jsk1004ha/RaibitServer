package backup

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type testJournal struct {
	mu        sync.Mutex
	intent    bool
	upload    bool
	candidate Candidate
	fail      string
	fences    int
}

func (j *testJournal) RecordIntent(context.Context, Attempt) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.intent || j.fail == "intent" {
		return ErrFence
	}
	j.intent = true
	return nil
}

func (j *testJournal) RecordUpload(context.Context, Upload) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.intent || j.fail == "upload" {
		return ErrFence
	}
	j.upload = true
	return nil
}

func (j *testJournal) RecordCandidate(_ context.Context, c Candidate) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.upload || j.fail == "candidate" {
		return ErrFence
	}
	j.candidate = c
	return nil
}

func (j *testJournal) Fence(context.Context, Attempt) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.fences++
	if j.fail == "fence" || (j.fail == "final-fence" && j.fences >= 3) {
		return ErrFence
	}
	return nil
}

func (j *testJournal) AuthorizeCleanup(context.Context, Attempt) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.fail == "cleanup" {
		return ErrFence
	}
	return nil
}

func fixture(t *testing.T, mode string, options Options) (*Service, *wireStore, *testJournal, Attempt) {
	t.Helper()
	j := &testJournal{}
	a, err := NewAttempt(AttemptSpec{OrganizationID: "org-1", ResourceID: "resource-1", BackupID: "backup-1", KeyVersion: "key-1", Number: 1, FirstClaimAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	w := &wireStore{t: t, journal: j, key: a.ObjectKey(), mode: mode, parts: make(map[int][]byte)}
	server := httptest.NewTLSServer(w)
	t.Cleanup(server.Close)
	config, err := ParseOperator(map[string]string{"RAIBITSERVER_PROVISIONER_BACKUP_ENABLED": "true", "RAIBITSERVER_PROVISIONER_BACKUP_ENDPOINT": server.URL, "RAIBITSERVER_PROVISIONER_BACKUP_BUCKET": "private-test", "RAIBITSERVER_PROVISIONER_BACKUP_CONFIG_FILE": ConfigFile})
	if err != nil {
		t.Fatal(err)
	}
	options.TLSConfig = server.Client().Transport.(*http.Transport).TLSClientConfig
	bundle, err := ParseBundle(strings.NewReader(bundleJSON()))
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewService(config, bundle, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, w, j, a
}

func bundleJSON() string {
	return `{"version":1,"accessKeyId":"local-access","secretAccessKey":"local-secret","currentKeyVersion":"key-1","keys":{"key-1":"` + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)) + `"}}`
}

func readbackContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func uploadFixture(t *testing.T, s *Service, j *testJournal, a Attempt, size int) Candidate {
	t.Helper()
	c, err := s.Upload(context.Background(), UploadRequest{Attempt: a, Source: io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{0x5a}, size)))}, j)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (w *wireStore) eventSnapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	events := append([]string(nil), w.events...)
	sort.Strings(events)
	return events
}
