package worker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

type helperFixtureStore struct {
	controlplane.Store
	credential  controlplane.GitHubRepositoryCredential
	released    atomic.Bool
	failRelease bool
	denied      atomic.Bool
}

func (s *helperFixtureStore) CheckGitHubRepositoryCredential(context.Context) error {
	if s.released.Load() || s.denied.Load() {
		return errGitHubHelper
	}
	return nil
}

func (s *helperFixtureStore) IssueGitHubRepositoryCredential(context.Context, controlplane.GitHubRepositoryCredentialRequest) (*controlplane.GitHubRepositoryCredential, error) {
	value := s.credential
	return &value, nil
}

func (s *helperFixtureStore) ReleaseGitHubRepositoryCredential(_ context.Context, succeeded bool) error {
	s.released.Store(true)
	if s.failRelease {
		return errors.New("revocation acknowledgement unavailable")
	}
	return nil
}

func helperGitFixture(t *testing.T, store *helperFixtureStore) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		command := exec.Command("git", args...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture git: %v %s", err, output)
		}
	}
	source := filepath.Join(root, "work")
	git("init", "-q", "-b", "main", source)
	if err := os.WriteFile(filepath.Join(source, "sentinel.txt"), []byte("private-clone-sentinel\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("-C", source, "add", "sentinel.txt")
	git("-C", source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture")
	repo := filepath.Join(root, "acme", "private.git")
	git("clone", "-q", "--bare", source, repo)
	gitPath, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Fatal(err)
	}
	backend := &cgi.Handler{Path: filepath.Join(strings.TrimSpace(string(gitPath)), "git-http-backend"), Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1"}}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "x-access-token" || password != store.credential.Token || store.released.Load() {
			w.Header().Set("WWW-Authenticate", `Basic realm="private"`)
			w.WriteHeader(401)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/acme/private.git/") {
			w.WriteHeader(403)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "github.com"}, DNSNames: []string{"github.com"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, public, private)
	if err != nil {
		t.Fatal(err)
	}
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: private}}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	t.Cleanup(server.Close)
	ca := filepath.Join(root, "fixture-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "github.com:443" {
			w.WriteHeader(403)
			return
		}
		target, err := net.Dial("tcp", server.Listener.Addr().String())
		if err != nil {
			w.WriteHeader(502)
			return
		}
		defer target.Close()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			w.WriteHeader(500)
			return
		}
		client, buffer, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		if _, err := buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffer.Flush(); err != nil {
			return
		}
		done := make(chan struct{})
		go func() { defer close(done); io.Copy(client, target); client.Close() }()
		io.Copy(target, client)
		target.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)
	helper := filepath.Join(root, "builder-helper")
	command := exec.Command("go", "build", "-o", helper, "../../cmd/builder")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build real helper: %v %s", err, output)
	}
	return proxy.URL, ca, helper
}
