package recoveryreceipt

import (
	"encoding/json"
	"errors"
	"io"
	"os"
)

var ErrWrite = errors.New("recovery receipt: write failed")

func Write(destination io.Writer, receipt Receipt) error {
	if destination == nil || validateSpec(receipt.spec) != nil {
		return ErrWrite
	}
	payload, err := json.Marshal(toWire(receipt))
	if err != nil {
		return ErrWrite
	}
	payload = append(payload, '\n')
	if len(payload) > MaxBytes {
		return ErrWrite
	}
	written, err := destination.Write(payload)
	if err != nil || written != len(payload) {
		return ErrWrite
	}
	return nil
}

func WriteTerminationLog(receipt Receipt) (resultErr error) {
	destination, err := os.OpenFile(TerminationLogPath, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return ErrWrite
	}
	defer func() {
		if closeErr := destination.Close(); closeErr != nil {
			resultErr = ErrWrite
		}
	}()
	return Write(destination, receipt)
}
