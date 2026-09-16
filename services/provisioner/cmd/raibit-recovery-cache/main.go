package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/raibitserver/provisioner/internal/recoverycache"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	action, err := recoverycache.ParseAction(os.Args[1:])
	if err == nil {
		err = recoverycache.Run(ctx, action, os.Stdin, os.Stdout)
	}
	if err != nil {
		if _, writeErr := fmt.Fprintln(os.Stderr, err); writeErr != nil {
			os.Exit(1)
		}
		os.Exit(1)
	}
}
