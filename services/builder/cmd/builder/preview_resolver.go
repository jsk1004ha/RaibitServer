package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/raibitserver/builder/internal/controlplane"
)

func runPreviewResolverLoop(ctx context.Context, resolver *controlplane.PreviewResolver, workerID string, interval time.Duration) {
	for {
		_, err := resolver.ResolveNext(ctx, workerID)
		if err != nil && ctx.Err() == nil {
			fmt.Fprintln(os.Stderr, "preview resolver iteration failed")
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
