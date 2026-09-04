package backup

import (
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

type DirectCommand struct {
	executable string
	args       []string
}

// newDirectCommand is intentionally package-private: engine adapters own every argv byte.
func newDirectCommand(executable string, args ...string) (DirectCommand, error) {
	base := path.Base(executable)
	if len(executable) == 0 || len(executable) > 256 || base != executable || strings.ContainsAny(executable, "\x00/\\ \t\r\n") || isShell(base) || len(args) > 64 {
		return DirectCommand{}, ErrRecoveryJob
	}
	for _, arg := range args {
		if len(arg) == 0 || len(arg) > 4096 || strings.ContainsRune(arg, '\x00') || strings.Contains(arg, "$(") {
			return DirectCommand{}, ErrRecoveryJob
		}
	}
	return DirectCommand{executable: executable, args: slices.Clone(args)}, nil
}

func isShell(executable string) bool {
	switch strings.ToLower(executable) {
	case "sh", "bash", "dash", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "env":
		return true
	}
	return false
}

func (c DirectCommand) Executable() string { return c.executable }
func (c DirectCommand) Args() []string     { return slices.Clone(c.args) }

type StreamBinding uint8

const (
	StreamNone StreamBinding = iota
	StreamStdin
	StreamStdout
)

type CommandStep struct {
	command DirectCommand
	binding StreamBinding
}

func newCommandStep(command DirectCommand, binding StreamBinding) (CommandStep, error) {
	if command.executable == "" || binding > StreamStdout {
		return CommandStep{}, ErrRecoveryJob
	}
	return CommandStep{command: command, binding: binding}, nil
}

func (s CommandStep) Command() DirectCommand { return s.command }
func (s CommandStep) Binding() StreamBinding { return s.binding }

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

type SecretFile struct {
	mountPath string
	ref       SecretRef
}

func NewSecretFile(mountPath string, ref SecretRef) (SecretFile, error) {
	clean := path.Clean(mountPath)
	if clean != mountPath || !strings.HasPrefix(clean, "/var/run/raibit-recovery/") || clean == "/var/run/raibit-recovery" || !validSecretRef(ref) {
		return SecretFile{}, ErrRecoveryJob
	}
	return SecretFile{mountPath: mountPath, ref: ref}, nil
}

func (f SecretFile) MountPath() string { return f.mountPath }
func (f SecretFile) Ref() SecretRef    { return f.ref }
func (SecretFile) ReadOnly() bool      { return true }

type RuntimeSecurity struct {
	runAsUser                              int64
	runAsNonRoot, readOnlyRootFilesystem   bool
	allowPrivilegeEscalation, automountSAT bool
	dropAllCapabilities                    bool
}

func (s RuntimeSecurity) RunAsUser() int64                   { return s.runAsUser }
func (s RuntimeSecurity) RunAsNonRoot() bool                 { return s.runAsNonRoot }
func (s RuntimeSecurity) ReadOnlyRootFilesystem() bool       { return s.readOnlyRootFilesystem }
func (s RuntimeSecurity) AllowPrivilegeEscalation() bool     { return s.allowPrivilegeEscalation }
func (s RuntimeSecurity) AutomountServiceAccountToken() bool { return s.automountSAT }
func (s RuntimeSecurity) DropAllCapabilities() bool          { return s.dropAllCapabilities }

type NetworkPolicy interface{ recoveryNetworkPolicy() }

type EndpointEgressPolicy struct {
	host        string
	port        uint16
	defaultDeny bool
}

func (EndpointEgressPolicy) recoveryNetworkPolicy() {}
func (p EndpointEgressPolicy) Host() string         { return p.host }
func (p EndpointEgressPolicy) Port() uint16         { return p.port }
func (p EndpointEgressPolicy) DefaultDeny() bool    { return p.defaultDeny }

type VolumeOnlyPolicy struct {
	volume, root string
	defaultDeny  bool
}

func (VolumeOnlyPolicy) recoveryNetworkPolicy() {}
func (p VolumeOnlyPolicy) Volume() string       { return p.volume }
func (p VolumeOnlyPolicy) Root() string         { return p.root }
func (p VolumeOnlyPolicy) DefaultDeny() bool    { return p.defaultDeny }
func (VolumeOnlyPolicy) AllowsEgress() bool     { return false }

type FenceIdentity struct {
	operationID string
	attempt     int
}

func (f FenceIdentity) OperationID() string { return f.operationID }
func (f FenceIdentity) Attempt() int        { return f.attempt }

type IsolatedJobSpec struct {
	Namespace, Image, OperationID                string
	Attempt                                      int
	Connection                                   Connection
	Steps                                        []CommandStep
	Secrets                                      []SecretEnv
	SecretFiles                                  []SecretFile
	RunAsUser, CPUMilli, MemoryMiB, EphemeralMiB int64
	Deadline                                     time.Duration
}

type IsolatedJob struct {
	spec     IsolatedJobSpec
	security RuntimeSecurity
	policy   NetworkPolicy
	labels   map[string]string
	fence    FenceIdentity
}

func NewIsolatedJob(spec IsolatedJobSpec) (IsolatedJob, error) {
	if !recoveryPart.MatchString(spec.Namespace) || spec.Namespace != spec.Connection.spec.Provenance.spec.Namespace || spec.Image != spec.Connection.toolImage || spec.OperationID != spec.Connection.operationID || spec.Attempt != spec.Connection.attempt || spec.Connection.spec.ResourceID == "" || spec.RunAsUser < 1 || spec.CPUMilli < 1 || spec.CPUMilli > 4000 || spec.MemoryMiB < 16 || spec.MemoryMiB > 8192 || spec.EphemeralMiB < 16 || spec.EphemeralMiB > 16384 || spec.Deadline < time.Second || spec.Deadline > MaxDuration || len(spec.Steps) == 0 || len(spec.Steps) > 8 || len(spec.Secrets) > 16 || len(spec.SecretFiles) > 8 {
		return IsolatedJob{}, ErrRecoveryJob
	}
	streamBindings := 0
	for _, step := range spec.Steps {
		if step.command.executable == "" || step.binding > StreamStdout {
			return IsolatedJob{}, ErrRecoveryJob
		}
		if step.binding != StreamNone {
			streamBindings++
		}
	}
	if streamBindings != 1 || !validJobSecrets(spec) || commandLeaksEndpoint(spec.Steps, spec.Connection.Endpoint()) {
		return IsolatedJob{}, ErrRecoveryJob
	}
	policy := policyFor(spec.Connection.Endpoint())
	if policy == nil {
		return IsolatedJob{}, ErrRecoveryJob
	}
	spec.Steps, spec.Secrets, spec.SecretFiles = slices.Clone(spec.Steps), slices.Clone(spec.Secrets), slices.Clone(spec.SecretFiles)
	fence := FenceIdentity{operationID: spec.OperationID, attempt: spec.Attempt}
	labels := map[string]string{"raibitserver.io/owned-by": "recovery", "raibitserver.io/operation": spec.OperationID, "raibitserver.io/resource": spec.Connection.ResourceID(), "raibitserver.io/attempt": strconv.Itoa(spec.Attempt)}
	security := RuntimeSecurity{runAsUser: spec.RunAsUser, runAsNonRoot: true, readOnlyRootFilesystem: true, dropAllCapabilities: true}
	job := IsolatedJob{spec: spec, security: security, policy: policy, labels: labels, fence: fence}
	job.labels["raibitserver.io/spec-identity"] = isolatedJobIdentity(job)
	return job, nil
}

func validJobSecrets(spec IsolatedJobSpec) bool {
	if spec.Connection.Engine() == EngineSQLite {
		return len(spec.Secrets) == 0 && len(spec.SecretFiles) == 0
	}
	seen := make(map[string]struct{}, len(spec.Secrets)+len(spec.SecretFiles))
	boundCredential := false
	for _, secret := range spec.Secrets {
		if secret.ref.namespace != spec.Namespace || !secretEnvName.MatchString(secret.name) || !validSecretRef(secret.ref) {
			return false
		}
		if _, exists := seen["env:"+secret.name]; exists {
			return false
		}
		boundCredential = boundCredential || secret.ref.sameRef(spec.Connection.spec.Secret)
		seen["env:"+secret.name] = struct{}{}
	}
	for _, secret := range spec.SecretFiles {
		if secret.ref.namespace != spec.Namespace || !strings.HasPrefix(secret.mountPath, "/var/run/raibit-recovery/") || !validSecretRef(secret.ref) {
			return false
		}
		if _, exists := seen["file:"+secret.mountPath]; exists {
			return false
		}
		boundCredential = boundCredential || secret.ref.sameRef(spec.Connection.spec.Secret)
		seen["file:"+secret.mountPath] = struct{}{}
	}
	return boundCredential
}

func policyFor(endpoint Endpoint) NetworkPolicy {
	switch value := endpoint.(type) {
	case NetworkEndpoint:
		return EndpointEgressPolicy{host: value.spec.Host, port: value.spec.Port, defaultDeny: true}
	case SQLiteEndpoint:
		return VolumeOnlyPolicy{volume: value.spec.Volume, root: value.spec.Root, defaultDeny: true}
	default:
		return nil
	}
}

func (j IsolatedJob) Spec() IsolatedJobSpec {
	j.spec.Steps, j.spec.Secrets, j.spec.SecretFiles = slices.Clone(j.spec.Steps), slices.Clone(j.spec.Secrets), slices.Clone(j.spec.SecretFiles)
	return j.spec
}
func (j IsolatedJob) Security() RuntimeSecurity    { return j.security }
func (j IsolatedJob) NetworkPolicy() NetworkPolicy { return j.policy }
func (j IsolatedJob) Fence() FenceIdentity         { return j.fence }
func (j IsolatedJob) Labels() map[string]string    { return cloneMap(j.labels) }

func cloneMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
