//go:build !windows

package recoveryreceipt

import (
	"os"
	"path/filepath"
	"testing"
)

func secureStageTestDirectory(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func makeStageObjectUnsafe(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o777); err != nil {
		t.Fatal(err)
	}
}

func createStageReparse(t *testing.T, directory, path string) {
	t.Helper()
	target := filepath.Join(directory, "replacement.json")
	if err := os.WriteFile(target, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}
