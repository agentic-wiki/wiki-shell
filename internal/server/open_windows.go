package server

// openFlags: Windows has no O_NOFOLLOW; the Fstat check still refuses what
// isn't a regular file.
const openFlags = 0
