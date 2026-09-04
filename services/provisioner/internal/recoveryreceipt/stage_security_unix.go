//go:build !windows

package recoveryreceipt

import (
	"io/fs"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func openStageDirectory(path string) (*os.File, error) {
	descriptor, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(descriptor), path), nil
}

func openStageFile(_ *os.Root, directory *os.File, name string) (*os.File, error) {
	descriptor, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(descriptor), name), nil
}

func secureStageObject(_ *os.File, info fs.FileInfo, directory bool) bool {
	identity, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&fs.ModeSymlink != 0 {
		return false
	}
	permissions := info.Mode().Perm()
	if directory {
		if !info.IsDir() || permissions&0o002 != 0 {
			return false
		}
		ownerAccess := identity.Uid == uint32(os.Geteuid()) && permissions&0o700 == 0o700
		groupAccess := identity.Gid == uint32(os.Getegid()) && permissions&0o070 == 0o070
		if permissions&0o020 != 0 && identity.Gid != uint32(os.Getegid()) {
			return false
		}
		return ownerAccess || groupAccess
	}
	return info.Mode().IsRegular() && identity.Uid == uint32(os.Geteuid()) && permissions == 0o600
}

func syncStageDirectory(directory *os.File) error {
	return directory.Sync()
}
