package server

import (
	"bytes"
	"fmt"
	"net/http"
	"path"
	"strings"

	"github.com/agentic-wiki/wiki/parse"
)

// tableFormats are the downloads a page's table offers: what
// `wiki table --format csv|json` prints, through the same writer.
var tableFormats = map[string]struct {
	contentType string
	write       func(parse.Table, *bytes.Buffer) error
}{
	"csv":  {"text/csv; charset=utf-8", func(t parse.Table, b *bytes.Buffer) error { return t.WriteCSV(b) }},
	"json": {"application/json; charset=utf-8", func(t parse.Table, b *bytes.Buffer) error { return t.WriteJSON(b) }},
}

// handleTable downloads a page's one table, as a dataset's page offers it:
// `GET /api/table/{path}?format=csv|json`. The bytes are `wiki`'s writer's,
// so CSV cells that would run as a formula in a spreadsheet are disarmed
// with a leading `'`. A read, so a read-only network bind allows it, behind
// the same token as the rest of /api.
func (s *Server) handleTable(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	f, ok := tableFormats[format]
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody{"format must be csv or json"})
		return
	}
	e, err := s.entryAt(r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	}
	body, err := e.Body()
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	}
	tables := parse.Tables(body)
	switch {
	case len(tables) == 0:
		writeJSON(w, http.StatusNotFound, errorBody{"this page has no table."})
		return
	case len(tables) > 1:
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{fmt.Sprintf("this page has %d tables, and a dataset holds one.", len(tables))})
		return
	}
	var out bytes.Buffer
	if err := f.write(tables[0], &out); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
		return
	}
	h := w.Header()
	h.Set("Content-Type", f.contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Disposition", contentDisposition(e.Path, format))
	w.Write(out.Bytes())
}

// contentDisposition names the download after the page (RFC 6266): filename
// is the safe ASCII name, and filename* the page's own name, percent-encoded
// as UTF-8, which browsers prefer when they read it.
func contentDisposition(p, format string) string {
	real := strings.TrimSuffix(path.Base(p), ".md") + "." + format
	var enc strings.Builder
	for _, c := range []byte(real) {
		if isAttrChar(c) {
			enc.WriteByte(c)
		} else {
			fmt.Fprintf(&enc, "%%%02X", c)
		}
	}
	return fmt.Sprintf("attachment; filename=\"%s.%s\"; filename*=UTF-8''%s", downloadName(p), format, enc.String())
}

// isAttrChar is RFC 5987's attr-char: what filename* may hold unencoded.
func isAttrChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$&+-.^_`|~", c) >= 0
}

// downloadName is a page's file name made safe for a Content-Disposition
// header: its base without `.md`, keeping only ASCII letters, digits, `.`,
// `_` and `-`, each run of anything else one `-`. "dataset" if nothing is
// left.
func downloadName(p string) string {
	base := strings.TrimSuffix(path.Base(p), ".md")
	var b strings.Builder
	dash := false
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
			dash = false
		case !dash:
			b.WriteByte('-')
			dash = true
		}
	}
	if name := strings.Trim(b.String(), "-."); name != "" {
		return name
	}
	return "dataset"
}
