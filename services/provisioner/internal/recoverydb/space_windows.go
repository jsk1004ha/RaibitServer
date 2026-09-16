//go:build windows

package recoverydb

import (
	"golang.org/x/sys/windows"
)

func availableScratchBytes(path string) (uint64, error) {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, ErrWorkspace
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(pointer, &available, nil, nil); err != nil {
		return 0, ErrWorkspace
	}
	return available, nil
}
