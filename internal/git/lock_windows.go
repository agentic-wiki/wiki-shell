package git

import "os"

// lockFile does nothing on Windows: a file a process has open can't be
// removed there, so holding it open is the lock, and the system closes it
// when the process ends, however it ends.
func lockFile(f *os.File) error { return nil }
