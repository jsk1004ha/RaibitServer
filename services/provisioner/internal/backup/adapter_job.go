package backup

import (
	"context"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"
)

var imageReference = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$`)

type FixedCommand struct {
	executable string
	args       []string
}

func NewFixedCommand(executable string, args ...string) (FixedCommand, error) {
	command := FixedCommand{executable: executable, args: append([]string(nil), args...)}
	if !validFixedCommand(command) {
		return FixedCommand{}, ErrRecoveryJob
	}
	return command, nil
}

func fixedLiteral(value string) bool {
	return len(value) > 0 && len(value) <= 512 && !strings.ContainsAny(value, " \t\r\n$`'\";|&<>(){}[]!*?\\")
}

func validFixedCommand(command FixedCommand) bool {
	if !fixedLiteral(command.executable) || len(command.args) > 32 {
		return false
	}
	for _, arg := range command.args {
		if !fixedLiteral(arg) {
			return false
		}
	}
	return true
}

func (c FixedCommand) Executable() string { return c.executable }
func (c FixedCommand) Args() []string     { return append([]string(nil), c.args...) }

type SecretEnv struct {
	name string
	ref  SecretRef
}

func NewSecretEnv(name string, ref SecretRef) (SecretEnv, error) {
	if !secretEnvName.MatchString(name) || !validSecretRef(ref) {
		return SecretEnv{}, ErrRecoveryJob
	}
	return SecretEnv{name: name, ref: ref}, nil
}

func (e SecretEnv) Name() string   { return e.name }
func (e SecretEnv) Ref() SecretRef { return e.ref }

type IsolatedJobSpec struct {
	Namespace           string
	Image               string
	Command             FixedCommand
	Secrets             []SecretEnv
	RunAsUser           int64
	CPUMilli, MemoryMiB int64
	Deadline            time.Duration
}

// IsolatedJob is a non-root, fixed-argv execution request. Its construction
// encodes the required bounded resources; no shell or plaintext secret exists.
type IsolatedJob struct{ spec IsolatedJobSpec }

func NewIsolatedJob(spec IsolatedJobSpec) (IsolatedJob, error) {
	if !recoveryPart.MatchString(spec.Namespace) || !imageReference.MatchString(spec.Image) || !validFixedCommand(spec.Command) || spec.RunAsUser < 1 || spec.CPUMilli < 1 || spec.CPUMilli > 4000 || spec.MemoryMiB < 16 || spec.MemoryMiB > 8192 || spec.Deadline < time.Second || spec.Deadline > MaxDuration || len(spec.Secrets) > 16 {
		return IsolatedJob{}, ErrRecoveryJob
	}
	seen := make(map[string]struct{}, len(spec.Secrets))
	for _, env := range spec.Secrets {
		if env.ref.namespace != spec.Namespace || !secretEnvName.MatchString(env.name) || !validSecretRef(env.ref) {
			return IsolatedJob{}, ErrRecoveryJob
		}
		if _, exists := seen[env.name]; exists {
			return IsolatedJob{}, ErrRecoveryJob
		}
		seen[env.name] = struct{}{}
	}
	spec.Secrets = append([]SecretEnv(nil), spec.Secrets...)
	return IsolatedJob{spec: spec}, nil
}

func (j IsolatedJob) Spec() IsolatedJobSpec {
	j.spec.Secrets = append([]SecretEnv(nil), j.spec.Secrets...)
	return j.spec
}
func (j IsolatedJob) Command() FixedCommand { return j.spec.Command }

type JobStream struct {
	input  io.ReadCloser
	output io.WriteCloser
}

func NewDumpStream(output io.WriteCloser) (JobStream, error) {
	if output == nil {
		return JobStream{}, ErrRecoveryStream
	}
	return JobStream{output: output}, nil
}

func NewRestoreStream(input io.ReadCloser) (JobStream, error) {
	if input == nil {
		return JobStream{}, ErrRecoveryStream
	}
	return JobStream{input: input}, nil
}

func (s JobStream) Input() io.ReadCloser   { return s.input }
func (s JobStream) Output() io.WriteCloser { return s.output }
func (s JobStream) Close() error {
	var errs []error
	if s.input != nil {
		errs = append(errs, s.input.Close())
	}
	if s.output != nil {
		errs = append(errs, s.output.Close())
	}
	return errors.Join(errs...)
}

type JobReceipt struct {
	name  string
	bytes int64
}

func NewJobReceipt(name string, streamedBytes int64) (JobReceipt, error) {
	if !recoveryPart.MatchString(name) || streamedBytes < 0 || streamedBytes > MaxStoredBytes {
		return JobReceipt{}, ErrRecoveryJob
	}
	return JobReceipt{name: name, bytes: streamedBytes}, nil
}

func (r JobReceipt) Name() string { return r.name }
func (r JobReceipt) Bytes() int64 { return r.bytes }

// JobRunner owns JobStream and MUST close it on every outcome, including a
// context cancellation. Implementations stream directly; they must not buffer
// recovery artifacts in memory.
type JobRunner interface {
	Run(context.Context, IsolatedJob, JobStream) (JobReceipt, error)
}
