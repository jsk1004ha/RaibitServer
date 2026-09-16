package reconciler

import (
	"errors"

	"github.com/raibitserver/provisioner/internal/store"
)

func ordinaryPublicationResult(result *Result, err error) (*Result, error) {
	if errors.Is(err, store.ErrRecoveryPrepared) {
		result.Status = store.StatusProvisioning
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}
