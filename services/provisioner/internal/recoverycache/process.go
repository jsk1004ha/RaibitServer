package recoverycache

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type processKind uint8

const (
	processProbe processKind = iota + 1
	processCapture
	processValidate
	processServer
)

func (k processKind) String() string {
	switch k {
	case processProbe:
		return "probe"
	case processCapture:
		return "capture"
	case processValidate:
		return "validate"
	case processServer:
		return "server"
	default:
		return "invalid"
	}
}

type processRequest struct {
	kind   processKind
	engine engine
	config config
	path   string
	socket string
}

type processExecutor interface {
	run(context.Context, processRequest) error
	start(context.Context, processRequest) (managedProcess, error)
	probe(context.Context, engine) error
}

type managedProcess interface {
	stop() error
	wait() error
}

type osProcessExecutor struct{}

func (osProcessExecutor) run(ctx context.Context, request processRequest) error {
	var credential []byte
	if request.kind == processCapture {
		var err error
		credential, err = request.config.readCredential()
		if err != nil {
			return err
		}
	}
	name, args, env, err := buildCommand(request, credential)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, name, args...)
	command.Env = mergeEnvironment(os.Environ(), env)
	command.Stdin = nil
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return ErrOperation
	}
	return nil
}

func mergeEnvironment(base, overlay []string) []string {
	if len(overlay) == 0 {
		return append([]string(nil), base...)
	}
	keys := make(map[string]struct{}, len(overlay))
	for _, value := range overlay {
		key, _, found := strings.Cut(value, "=")
		if found {
			keys[key] = struct{}{}
		}
	}
	result := make([]string, 0, len(base)+len(overlay))
	for _, value := range base {
		key, _, found := strings.Cut(value, "=")
		if _, replaced := keys[key]; found && replaced {
			continue
		}
		result = append(result, value)
	}
	return append(result, overlay...)
}

func (osProcessExecutor) start(ctx context.Context, request processRequest) (managedProcess, error) {
	name, args, env, err := buildCommand(request, nil)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, name, args...)
	command.Env = append(os.Environ(), env...)
	command.Stdin = nil
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, ErrOperation
	}
	return &osManagedProcess{command: command}, nil
}

func (osProcessExecutor) probe(ctx context.Context, engine engine) error {
	binaries := engineBinaries(engine)
	if binaries.cli == "" {
		return ErrCapability
	}
	if _, err := exec.LookPath(binaries.checker); err != nil {
		return ErrCapability
	}
	identity := "redis"
	if engine == engineValkey {
		identity = "valkey"
	}
	checks := []struct {
		name string
		args []string
		want string
	}{
		{name: binaries.cli, args: []string{"--help"}, want: "--rdb"},
		{name: binaries.cli, args: []string{"--version"}, want: identity},
		{name: binaries.server, args: []string{"--version"}, want: identity},
	}
	for _, check := range checks {
		var output bytes.Buffer
		command := exec.CommandContext(ctx, check.name, check.args...)
		command.Stdin = nil
		command.Stdout = &limitedBuffer{buffer: &output, max: 1 << 20}
		command.Stderr = &limitedBuffer{buffer: &output, max: 1 << 20}
		if err := command.Run(); err != nil || !strings.Contains(strings.ToLower(output.String()), check.want) {
			return ErrCapability
		}
	}
	return nil
}

type binarySet struct{ cli, checker, server string }

func engineBinaries(value engine) binarySet {
	switch value {
	case engineRedis:
		return binarySet{cli: "redis-cli", checker: "redis-check-rdb", server: "redis-server"}
	case engineValkey:
		return binarySet{cli: "valkey-cli", checker: "valkey-check-rdb", server: "valkey-server"}
	default:
		return binarySet{}
	}
}

func buildCommand(request processRequest, credential []byte) (string, []string, []string, error) {
	binaries := engineBinaries(request.engine)
	if binaries.cli == "" || request.path == "" {
		return "", nil, nil, ErrCapability
	}
	switch request.kind {
	case processCapture:
		if len(credential) == 0 || bytes.IndexByte(credential, 0) >= 0 {
			return "", nil, nil, ErrConfig
		}
		args := []string{
			"-h", request.config.host,
			"-p", strconv.FormatUint(uint64(request.config.port), 10),
			"--user", request.config.username,
			"-n", strconv.FormatUint(uint64(request.config.index), 10),
			"--rdb", request.path,
		}
		env := []string{"REDISCLI_AUTH=" + string(credential)}
		if request.engine == engineValkey {
			env = append(env, "VALKEYCLI_AUTH="+string(credential))
		}
		return binaries.cli, args, env, nil
	case processValidate:
		return binaries.checker, []string{request.path}, nil, nil
	case processServer:
		if request.socket == "" || request.config.scratchPath == "" {
			return "", nil, nil, ErrConfig
		}
		return binaries.server, []string{
			"--port", "0",
			"--unixsocket", request.socket,
			"--unixsocketperm", "600",
			"--dir", request.config.scratchPath,
			"--dbfilename", filepath.Base(request.path),
			"--save", "",
			"--appendonly", "no",
			"--maxmemory-policy", "noeviction",
			"--protected-mode", "yes",
			"--daemonize", "no",
		}, nil, nil
	default:
		return "", nil, nil, ErrOperation
	}
}

type osManagedProcess struct{ command *exec.Cmd }

func (p *osManagedProcess) stop() error {
	if p.command == nil || p.command.Process == nil || p.command.ProcessState != nil {
		return nil
	}
	if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return ErrOperation
	}
	return nil
}

func (p *osManagedProcess) wait() error {
	if p.command == nil {
		return nil
	}
	if err := p.command.Wait(); err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ProcessState != nil {
			return nil
		}
		return ErrOperation
	}
	return nil
}

type limitedBuffer struct {
	buffer *bytes.Buffer
	max    int
}

func (w *limitedBuffer) Write(value []byte) (int, error) {
	if w.buffer.Len()+len(value) > w.max {
		return 0, ErrLimit
	}
	return w.buffer.Write(value)
}
