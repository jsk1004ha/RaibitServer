package recoverydb

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
)

type nativeExecution struct {
	spec         processSpec
	streams      Streams
	reportStderr io.Writer
	target       endpoint
}

func executeNative(ctx context.Context, request nativeExecution, executor processExecutor) error {
	var nativeStderr cappedBuffer
	request.streams.Stderr = &nativeStderr
	encodedPassword := strings.TrimPrefix(url.UserPassword("", request.target.password).String(), ":")
	if err := executor.Execute(ctx, request.spec, request.streams); err != nil {
		if writeErr := nativeStderr.writeRedacted(request.reportStderr, request.target.host, request.target.database, request.target.username, request.target.password, encodedPassword); writeErr != nil {
			return ErrStream
		}
		if cause := context.Cause(ctx); cause != nil {
			return cause
		}
		return ErrProcessFailed
	}
	if err := nativeStderr.writeRedacted(request.reportStderr, request.target.host, request.target.database, request.target.username, request.target.password, encodedPassword); err != nil {
		return errors.Join(ErrStream, err)
	}
	return nil
}

func verifyTarget(ctx context.Context, request nativeExecution, executor processExecutor) error {
	var stdout boundedVerificationCapture
	request.streams.Stdout = &stdout
	if err := executeNative(ctx, request, executor); err != nil {
		return err
	}
	if string(stdout.bytes) != "raibitserver-recovery-v1\n" {
		return ErrBaseline
	}
	return nil
}

type boundedVerificationCapture struct {
	bytes []byte
}

func (c *boundedVerificationCapture) Write(value []byte) (int, error) {
	if len(c.bytes)+len(value) > 128 {
		return 0, ErrBaseline
	}
	c.bytes = append(c.bytes, value...)
	return len(value), nil
}
