package backup

import (
	"strings"

	"github.com/raibitserver/provisioner/internal/recoveryreceipt"
)

func completedHelperJob(job IsolatedJob, name string) (completedJobObservation, error) {
	engine, action, direction, helper := expectedHelperReceipt(job)
	if !helper {
		return testCompletedJob(job, name), nil
	}
	verified := true
	verification := recoveryreceipt.VerificationSpec{Version: true, Schema: true, DecodedArtifact: true}
	if direction == recoveryreceipt.DirectionRestore {
		verification.Sentinel = &verified
		if engine == recoveryreceipt.EngineRedis || engine == recoveryreceipt.EngineValkey {
			verification.TTL = &verified
		}
	}
	receipt, err := recoveryreceipt.New(recoveryreceipt.Spec{
		Engine: engine, Action: action, Direction: direction,
		DecodedBytes: 4, DecodedSHA256: strings.Repeat("a", 64),
		Baseline:     &recoveryreceipt.BaselineSpec{SchemaSHA256: strings.Repeat("b", 64), DataSHA256: strings.Repeat("c", 64), RecordCount: 1},
		Verification: verification,
	})
	if err != nil {
		return completedJobObservation{}, err
	}
	observed := testCompletedJob(job, name)
	observed.receipt, observed.receiptPresent = receipt, true
	return observed, nil
}
