package ingester

import (
	"context"
	"errors"

	"github.com/raibitserver/metrics-ingester/internal/identity"
)

type Failure struct{ Code string }

func (f *Failure) Error() string { return "metrics_ingestion_" + f.Code }
func FailureCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, identity.ErrIdentity) {
		return "identity_rejected"
	}
	var failure *Failure
	if errors.As(err, &failure) {
		switch failure.Code {
		case "http_status", "http_transport", "http_decode", "byte_limit", "field_limit", "configuration", "database", "quantity":
			return failure.Code
		}
	}
	return "internal"
}
