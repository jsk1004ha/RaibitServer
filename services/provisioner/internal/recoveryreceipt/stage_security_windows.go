//go:build windows

package recoveryreceipt

import (
	"io/fs"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

func secureStageObject(file *os.File, info fs.FileInfo, directory bool) bool {
	if info.Mode()&fs.ModeSymlink != 0 || directory != info.IsDir() || !directory && !info.Mode().IsRegular() {
		return false
	}
	descriptor, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || descriptor == nil {
		return false
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil {
		return false
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || !owner.Equals(user.User.Sid) {
		return false
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil || dacl.AceCount == 0 {
		return false
	}
	system, systemErr := windows.StringToSid("S-1-5-18")
	administrators, adminErr := windows.StringToSid("S-1-5-32-544")
	if systemErr != nil || adminErr != nil {
		return false
	}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil || ace == nil {
			return false
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		// SAFETY: GetAce returned an ACCESS_ALLOWED_ACE; SidStart is the first byte of its variable-length SID.
		trustee := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !trustee.Equals(owner) && !trustee.Equals(system) && !trustee.Equals(administrators) {
			return false
		}
	}
	return true
}

func openStageDirectory(path string) (*os.File, error) {
	pathPointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		pathPointer,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

func openStageFile(root *os.Root, _ *os.File, name string) (*os.File, error) {
	return root.Open(name)
}

func syncStageDirectory(_ *os.File) error {
	// Windows does not permit FlushFileBuffers on directory handles; the atomic hard-link publication remains ordered after the file flush.
	return nil
}
