package ingester

import (
	"context"
	"sync/atomic"
)

type (
	budgetKey  struct{}
	byteBudget struct{ remaining atomic.Int64 }
)

// The per-run budget is propagated through discovery and owner lookups.
func WithByteBudget(ctx context.Context, limit int) context.Context {
	budget := &byteBudget{}
	budget.remaining.Store(int64(limit))
	return context.WithValue(ctx, budgetKey{}, budget)
}

func ConsumeBytes(ctx context.Context, count int) error {
	budget, ok := ctx.Value(budgetKey{}).(*byteBudget)
	if ok && budget.remaining.Add(-int64(count)) < 0 {
		return &Failure{Code: "byte_limit"}
	}
	return nil
}
