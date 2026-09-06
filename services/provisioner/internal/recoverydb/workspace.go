package recoverydb

import (
	"os"
	"path/filepath"
)

const (
	privateDirectoryMode os.FileMode = 0o700
	privateFileMode      os.FileMode = 0o600
)

type workspace struct {
	path string
}

func newWorkspace(root string) (workspace, error) {
	path, err := os.MkdirTemp(root, "db-")
	if err != nil {
		return workspace{}, ErrWorkspace
	}
	if err := os.Chmod(path, privateDirectoryMode); err != nil {
		if cleanupErr := os.RemoveAll(path); cleanupErr != nil {
			return workspace{}, ErrWorkspace
		}
		return workspace{}, ErrWorkspace
	}
	return workspace{path: path}, nil
}

func (w workspace) write(name string, content []byte) (string, error) {
	path := filepath.Join(w.path, name)
	if err := os.WriteFile(path, content, privateFileMode); err != nil {
		return "", ErrWorkspace
	}
	if err := os.Chmod(path, privateFileMode); err != nil {
		return "", ErrWorkspace
	}
	return path, nil
}

func (w workspace) close() error {
	if err := os.RemoveAll(w.path); err != nil {
		return ErrWorkspace
	}
	return nil
}
