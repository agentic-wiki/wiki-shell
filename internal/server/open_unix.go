//go:build !windows

package server

import "syscall"

// openFlags open a file without following a symlink at its last name, and
// without blocking if a FIFO was swapped in for it.
const openFlags = syscall.O_NOFOLLOW | syscall.O_NONBLOCK
