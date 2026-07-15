package worker

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

type Command struct {
	Name             string
	Args             []string
	Dir              string
	Env              map[string]string
	Stdin            string
	Redacted         string
	CleanGitEnv      bool
	CleanRegistryEnv bool
}

type CommandResult struct {
	Command  string
	DryRun   bool
	ExitCode int
	Stdout   string
	Stderr   string
}

type CommandRunner interface {
	Run(ctx context.Context, command Command, options CommandOptions) (CommandResult, error)
}

type CommandOptions struct {
	DryRun    bool
	Timeout   time.Duration
	Sensitive bool
}

type OSRunner struct{}

func (OSRunner) Run(ctx context.Context, command Command, options CommandOptions) (CommandResult, error) {
	printable := commandString(command)
	if options.DryRun {
		return CommandResult{Command: printable, DryRun: true, ExitCode: 0}, nil
	}
	if options.Timeout <= 0 {
		options.Timeout = 30 * time.Minute
	}
	cmdCtx, cancel := context.WithTimeout(ctx, options.Timeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, command.Name, command.Args...)
	if command.Dir != "" {
		cmd.Dir = command.Dir
	}
	cmd.Env = os.Environ()
	if command.CleanGitEnv {
		cmd.Env = withoutAmbientGitCredentials(cmd.Env)
	}
	if command.CleanRegistryEnv {
		cmd.Env = withoutAmbientRegistryCredentials(cmd.Env)
	}
	for key, value := range command.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	if command.Stdin != "" {
		cmd.Stdin = strings.NewReader(command.Stdin)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		exitCode = 1
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}
	result := CommandResult{Command: printable, DryRun: false, ExitCode: exitCode, Stdout: controlplane.Redact(stdout.String()), Stderr: controlplane.Redact(stderr.String())}
	if options.Sensitive {
		result.Stdout = ""
		result.Stderr = ""
	}
	if err != nil {
		if options.Sensitive {
			return result, fmt.Errorf("command failed (%d): %s (sensitive output omitted)", exitCode, printable)
		}
		return result, fmt.Errorf("command failed (%d): %s\n%s", exitCode, printable, firstNonEmptyOutput(result.Stderr, result.Stdout))
	}
	return result, nil
}

func withoutAmbientRegistryCredentials(environment []string) []string {
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		key := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			key = entry[:index]
		}
		switch strings.ToUpper(strings.TrimSpace(key)) {
		case "DOCKER_CONFIG", "REGISTRY_AUTH_FILE":
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func withoutAmbientGitCredentials(environment []string) []string {
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		key := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			key = entry[:index]
		}
		upper := strings.ToUpper(strings.TrimSpace(key))
		if strings.HasPrefix(upper, "GIT_") || strings.HasPrefix(upper, "RAIBITSERVER_GIT_") || upper == "GITHUB_TOKEN" || upper == "GH_TOKEN" || upper == "SSH_ASKPASS" {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

func commandString(command Command) string {
	if command.Redacted != "" {
		return command.Redacted
	}
	parts := append([]string{command.Name}, command.Args...)
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = shellQuote(controlplane.Redact(part))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && !strings.ContainsRune("_@%+=:,./-", r)
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func firstNonEmptyOutput(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
