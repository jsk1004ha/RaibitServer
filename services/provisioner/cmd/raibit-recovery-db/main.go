package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/raibitserver/provisioner/internal/recoverydb"
)

func main() {
	os.Exit(run(os.Args))
}

func run(args []string) int {
	if len(args) != 2 {
		_, _ = fmt.Fprintln(os.Stderr, recoverydb.ErrInvalidInput)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := recoverydb.Run(ctx, args[1], recoverydb.Streams{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr})
	if err == nil {
		return 0
	}
	_, _ = fmt.Fprintln(os.Stderr, err)
	if errors.Is(err, recoverydb.ErrInvalidInput) {
		return 2
	}
	return 1
}
