package recoverydb

import (
	"context"
	"io"
	"os/exec"
	"strings"
)

type processExecutor interface {
	Execute(context.Context, processSpec, Streams) error
}

type nativeExecutor struct{}

func (nativeExecutor) Execute(ctx context.Context, spec processSpec, streams Streams) error {
	command := exec.CommandContext(ctx, spec.executable, spec.args...)
	command.Env = append([]string(nil), spec.env...)
	command.Stdin = streams.Stdin
	command.Stdout = streams.Stdout
	command.Stderr = streams.Stderr
	return command.Run()
}

type cappedBuffer struct {
	bytes []byte
}

func (b *cappedBuffer) Write(value []byte) (int, error) {
	remaining := maxStderrBytes - len(b.bytes)
	if remaining > 0 {
		if len(value) < remaining {
			remaining = len(value)
		}
		b.bytes = append(b.bytes, value[:remaining]...)
	}
	return len(value), nil
}

func (b *cappedBuffer) writeRedacted(target io.Writer, secrets ...string) error {
	if target == nil || len(b.bytes) == 0 {
		return nil
	}
	replacements := make([]string, 0, len(secrets)*2)
	for _, secret := range secrets {
		if secret != "" {
			replacements = append(replacements, secret, "[redacted]")
		}
	}
	_, err := io.WriteString(target, strings.NewReplacer(replacements...).Replace(string(b.bytes)))
	return err
}
