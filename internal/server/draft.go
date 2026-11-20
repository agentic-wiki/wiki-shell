package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/agentic-wiki/wiki/index"
	"github.com/agentic-wiki/wiki/parse"
)

// handleDraftEntry drafts a new entry (the editor ADR, "Drafting a new
// entry"): `GET /api/entries/new?in={folder or entry}&type={type}&title=…`
// answers the path the entry would have and its whole first content (a
// header of type, title and tags: []), which
// the client posts unchanged to POST /api/entries. It writes nothing, so a
// read-only bind allows it. The rules are wiki's: the file name is
// parse.FileSlug of the title, and the type one wiki.toml declares.
//
// Under a folder the entry is {folder}/{slug}.md; under an entry
// /spec/thing.md, it is /spec/thing/{slug}.md, never thing/index.md.
func (s *Server) handleDraftEntry(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	title, typ := strings.TrimSpace(q.Get("title")), strings.TrimSpace(q.Get("type"))
	refuse := func(reason string) { writeJSON(w, http.StatusUnprocessableEntity, errorBody{reason}) }

	folder := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(q.Get("in"), "/"), "/"), ".md")
	slug := parse.FileSlug(title)
	bundle := s.store.View().Index.Bundle
	switch {
	case slug == "":
		refuse("a title needs a letter or a digit, to name its file")
		return
	case slug == "index" || slug == "log":
		refuse(fmt.Sprintf("%q names a reserved file (%s.md): choose another title", title, slug))
		return
	case typ == "":
		refuse("an entry needs a type")
		return
	case !bundle.KnownType(typ):
		refuse(fmt.Sprintf("type `%s` isn't one wiki.toml declares (%s): add it to `types` there, or pick one of those", typ, strings.Join(bundle.Types, ", ")))
		return
	}
	// Create's own check of the path (wiki's), so the draft and the create
	// can't disagree: no `..`, empty or dot segment, not a path wiki.toml's
	// ignore leaves out, inside the bundle once links are followed, and free.
	// Joined by hand: path.Join would clean away the segments wiki refuses.
	rel := slug + ".md"
	if folder != "" {
		rel = folder + "/" + rel
	}
	switch err := s.store.View().Index.CheckNewEntry("/" + rel); {
	case errors.Is(err, index.ErrExists):
		writeTaken(w, "/"+rel)
		return
	case err != nil:
		refuse(err.Error())
		return
	}
	// The header is type, title and an empty tags list, nothing else (the
	// CEO's call), each written by wiki's own field writers.
	content, err := parse.SetField("", "type", typ)
	if err == nil {
		content, err = parse.SetField(content, "title", title)
	}
	if err == nil {
		content, err = parse.SetFieldList(content, "tags", []string{})
	}
	if err != nil {
		refuse(err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": "/" + rel, "content": content})
}

// writeTaken is the 409 of a new page whose path is taken, from the draft or
// the create: the taken path comes with it, for the client to open it.
func writeTaken(w http.ResponseWriter, p string) {
	writeJSON(w, http.StatusConflict, map[string]string{"error": "There is already an entry at " + p + ".", "path": p})
}
