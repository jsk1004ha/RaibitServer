package recoveryreceipt

import (
	"io/fs"
	"os"
	"strings"
)

const stageClaimPrefix = ".recovery-stage-claim-"

func hiddenClaimsPresent(root stageRoot) (present bool, resultErr error) {
	directory, err := root.root.Open(".")
	if err != nil {
		return false, ErrStage
	}
	defer func() {
		if directory.Close() != nil {
			present, resultErr = false, ErrStage
		}
	}()
	directoryInfo, err := directory.Stat()
	trustedInfo, trustedErr := root.directory.Stat()
	if err != nil || trustedErr != nil || !os.SameFile(directoryInfo, trustedInfo) || !secureStageObject(directory, directoryInfo, true) {
		return false, ErrStage
	}
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return false, ErrStage
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), stageClaimPrefix) {
			continue
		}
		if !validClaimName(entry.Name()) || validateHiddenClaim(root, entry.Name()) != nil {
			return true, ErrStage
		}
		return true, nil
	}
	return false, nil
}

func validClaimName(name string) bool {
	suffix := strings.TrimPrefix(name, stageClaimPrefix)
	if len(suffix) != 32 {
		return false
	}
	for _, value := range []byte(suffix) {
		if value < '0' || value > '9' {
			if value < 'a' || value > 'f' {
				return false
			}
		}
	}
	return true
}

func validateHiddenClaim(root stageRoot, name string) error {
	pathInfo, err := root.root.Lstat(name)
	if err != nil || pathInfo.Mode()&fs.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return ErrStage
	}
	file, err := openStageFile(root.root, root.directory, name)
	if err != nil {
		return ErrStage
	}
	actual, statErr := file.Stat()
	secure := statErr == nil && os.SameFile(pathInfo, actual) && secureStageObject(file, actual, false)
	closeErr := file.Close()
	if !secure || closeErr != nil {
		return ErrStage
	}
	return nil
}
