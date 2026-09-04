//go:build !windows

package recoverydb

import (
	"golang.org/x/sys/unix"
)

func availableScratchBytes(path string) (uint64, error) {
	var stats unix.Statfs_t
	if err := unix.Statfs(path, &stats); err != nil {
		return 0, ErrWorkspace
	}
	return stats.Bavail * uint64(stats.Bsize), nil
}
