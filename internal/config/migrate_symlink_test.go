package config

import (
	"os"
	"path/filepath"
	"testing"
)

// A cloned repo can ship wiki.toml as a symlink to a file outside it. Migrate
// leaves the link alone, as Foreman does: writing would replace the link with a
// regular file holding the outside file's content.
func TestMigrateLeavesASymlinkAlone(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	target := filepath.Join(outside, "private.toml")
	if err := os.WriteFile(target, []byte("spec = \"0.1\"\n\n[[tool.wikiview.board]]\nid = \"a\"\npath = \"/\"\nsecret = \"outside the repo\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "wiki.toml")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Migrate(dir); err == nil {
		t.Error("Migrate wrote through a symlinked wiki.toml, want an error")
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("wiki.toml is no longer the symlink: %v %v", fi.Mode(), err)
	}
}
