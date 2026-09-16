package worker

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

var errGitHubHelper = errors.New("GitHub clone credential helper denied")

type gitHubCredentialHelper struct {
	listener net.Listener
	done     chan struct{}
	cancel   context.CancelFunc
	once     sync.Once
	closeErr error
}

type gitHubHelperScope struct {
	Credential *controlplane.GitHubRepositoryCredential
	Repository string
	Authorize  func(context.Context) error
}

func newGitHubCredentialHelper(ctx context.Context, socket string, scope gitHubHelperScope) (*gitHubCredentialHelper, error) {
	credential := scope.Credential
	if credential == nil || credential.Token == "" || strings.ContainsAny(credential.Token, "\r\n\x00") || len(credential.Token) > 4096 || !credential.UseDeadline.After(time.Now()) || credential.UseDeadline.After(time.Now().Add(15*time.Minute)) {
		return nil, errGitHubHelper
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, errGitHubHelper
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		return nil, errors.Join(errGitHubHelper, listener.Close())
	}
	helperCtx, cancel := context.WithDeadline(ctx, credential.UseDeadline)
	h := &gitHubCredentialHelper{listener: listener, done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(h.done)
		defer cancel()
		stopClose := context.AfterFunc(helperCtx, func() { listener.Close() })
		defer stopClose()
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			deadline := time.Now().Add(2 * time.Second)
			if credential.UseDeadline.Before(deadline) {
				deadline = credential.UseDeadline
			}
			if conn.SetDeadline(deadline) == nil {
				request, readErr := io.ReadAll(io.LimitReader(conn, 16385))
				if readErr == nil && len(request) <= 16384 && helperCtx.Err() == nil && exactGitCredentialRequest(string(request), scope.Repository) {
					checkCtx, stopCheck := context.WithDeadline(helperCtx, deadline)
					checkErr := scope.Authorize(checkCtx)
					stopCheck()
					if checkErr != nil || helperCtx.Err() != nil {
						conn.Close()
						continue
					}
					if _, writeErr := io.WriteString(conn, "username=x-access-token\npassword="+credential.Token+"\n\n"); writeErr != nil {
						conn.Close()
						continue
					}
				}
			}
			conn.Close()
		}
	}()
	return h, nil
}

func exactGitCredentialRequest(input, repository string) bool {
	fields := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(input))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || fields[key] != "" {
			return false
		}
		switch key {
		case "protocol", "host", "path", "username":
			fields[key] = value
		case "wwwauth[]", "capability[]":
		default:
			return false
		}
	}
	return scanner.Err() == nil && fields["protocol"] == "https" && fields["host"] == "github.com" &&
		(strings.EqualFold(fields["path"], repository+".git") || strings.EqualFold(fields["path"], repository)) &&
		(fields["username"] == "" || fields["username"] == "x-access-token")
}

func (h *gitHubCredentialHelper) Close() error {
	h.once.Do(func() {
		h.cancel()
		if err := h.listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			h.closeErr = errGitHubHelper
		}
		<-h.done
	})
	return h.closeErr
}

// RunGitCredentialHelper is the existing builder binary's private helper mode.
// Only a socket path and operation are passed in argv; credentials travel on pipes.
func RunGitCredentialHelper(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	if len(args) != 2 {
		return errGitHubHelper
	}
	switch args[1] {
	case "store", "erase":
		return nil
	case "get":
	default:
		return errGitHubHelper
	}
	request, err := io.ReadAll(io.LimitReader(input, 16385))
	if err != nil || len(request) > 16384 {
		return errGitHubHelper
	}
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", args[0])
	if err != nil {
		return errGitHubHelper
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		return errGitHubHelper
	}
	if _, err := conn.Write(request); err != nil {
		return errGitHubHelper
	}
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		return errGitHubHelper
	}
	if err := unix.CloseWrite(); err != nil {
		return errGitHubHelper
	}
	response, err := io.ReadAll(io.LimitReader(conn, 8193))
	if err != nil || len(response) == 0 || len(response) > 8192 {
		return errGitHubHelper
	}
	if _, err := output.Write(response); err != nil {
		return errGitHubHelper
	}
	return nil
}

func (b *Builder) cloneWithGitHubCredential(ctx context.Context, state *buildContext, command Command) (result CommandResult, err error) {
	store, ok := b.Store.(gitHubRepositoryCredentialStore)
	if !ok {
		return result, errors.New("private GitHub repository requires an exact-repository per-build credential broker")
	}
	credential, err := store.IssueGitHubRepositoryCredential(ctx, controlplane.GitHubRepositoryCredentialRequest{ServiceID: state.Service.ID, InstallationID: state.Service.GitHubInstallationID, RepositoryID: state.Service.GitHubRepositoryID})
	if err != nil {
		return result, err
	}
	cloneSucceeded := false
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 8*time.Second)
		defer cancel()
		err = errors.Join(err, store.ReleaseGitHubRepositoryCredential(cleanupCtx, cloneSucceeded && err == nil))
	}()
	credentialDir, err := os.MkdirTemp("", "rb-gh-")
	if err != nil {
		return result, errGitHubHelper
	}
	defer func() {
		if cleanupErr := os.RemoveAll(credentialDir); cleanupErr != nil {
			err = errors.Join(err, errGitHubHelper)
		}
	}()
	socket := filepath.Join(credentialDir, "credential.sock")
	helper, err := newGitHubCredentialHelper(ctx, socket, gitHubHelperScope{Credential: credential, Repository: state.Service.GitHubRepository, Authorize: store.CheckGitHubRepositoryCredential})
	if err != nil {
		return result, err
	}
	defer func() { err = errors.Join(err, helper.Close()) }()
	executable := b.Config.GitCredentialHelperExecutable
	if executable == "" {
		executable, err = os.Executable()
		if err != nil {
			return result, errGitHubHelper
		}
	}
	command.Env["GIT_CONFIG_COUNT"] = "5"
	settings := [][2]string{{"credential.helper", ""}, {"credential.helper", shellQuote(executable) + " github-credential-helper " + shellQuote(socket)}, {"credential.useHttpPath", "true"}, {"http.followRedirects", "false"}, {"http.extraHeader", ""}}
	for index, setting := range settings {
		key := string(rune('0' + index))
		command.Env["GIT_CONFIG_KEY_"+key], command.Env["GIT_CONFIG_VALUE_"+key] = setting[0], setting[1]
	}
	cloneCtx, cancel := context.WithDeadline(ctx, credential.UseDeadline)
	defer cancel()
	result, err = b.Runner.Run(cloneCtx, command, CommandOptions{DryRun: b.Config.DryRun, Timeout: b.Config.Timeout, Sensitive: true})
	err = errors.Join(err, cloneCtx.Err())
	cloneSucceeded = err == nil && cloneCtx.Err() == nil
	return result, err
}
