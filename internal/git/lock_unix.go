//go:build !windows

package git

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive lock on f, or fails at once if a process holds
// one. The system drops it when the process ends, however it ends.
func lockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
