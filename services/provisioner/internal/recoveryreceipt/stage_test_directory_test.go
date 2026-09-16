package recoveryreceipt

import "testing"

func newStageTestDirectory(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	secureStageTestDirectory(t, directory)
	return directory
}
