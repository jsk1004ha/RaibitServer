package recoveryreceipt

import (
	"bytes"
	"errors"
	"testing"
)

type shortWriter struct{}

func (shortWriter) Write(payload []byte) (int, error) { return len(payload) - 1, nil }

func Test_Write_rejects_short_destination_write(t *testing.T) {
	// Given
	receipt, err := New(validSpec(ActionPostgreSQLDump, DirectionDump))
	if err != nil {
		t.Fatal(err)
	}

	// When
	err = Write(shortWriter{}, receipt)

	// Then
	if !errors.Is(err, ErrWrite) {
		t.Fatalf("error=%v", err)
	}
}

func Test_Write_emits_one_bounded_JSON_document(t *testing.T) {
	// Given
	receipt, err := New(validSpec(ActionValkeyRestore, DirectionRestore))
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer

	// When
	err = Write(&output, receipt)

	// Then
	if err != nil {
		t.Fatal(err)
	}
	if output.Len() == 0 || output.Len() > MaxBytes || output.Bytes()[output.Len()-1] != '\n' {
		t.Fatalf("invalid termination document length=%d", output.Len())
	}
}
