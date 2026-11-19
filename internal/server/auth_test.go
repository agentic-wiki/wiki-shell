package server

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// These tests are the fence's own: requests here are built by hand rather than
// through browserRequest, because what they are about is exactly what that helper
// supplies.
//
// The shared test servers bind `localhost`, the default: the header is required
// and any value passes, and the Host check is on. newNetworkServer binds
// `0.0.0.0`: the header must be this run's token, and there is no Host check.

// unauthenticated builds a request with the loopback Host and no header.
func unauthenticated(srv *Server, method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	r.Host = "127.0.0.1:0"
	return r
}

// withHeader adds the header the app would send to this server.
func withHeader(srv *Server, r *http.Request) *http.Request {
	r.Header.Set(tokenHeader, clientHeader(srv))
	return r
}

// serve runs one request through the whole fence and mux.
func serve(srv *Server, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, r)
	return rec
}

// newNetworkServer is the test bundle served on a network address, which turns
// the token on.
func newNetworkServer(t *testing.T) *Server {
	t.Helper()
	return New(newTestServer(t).store, nil, "0.0.0.0", 0)
}

// bothModes is a loopback server and a network server over the same fixture.
func bothModes(t *testing.T) map[string]*Server {
	return map[string]*Server{"loopback": newTestServer(t), "network": newNetworkServer(t)}
}

// The shell is the one thing a browser may fetch before it has a token: it is the
// program that asks for one.
func TestShellIsServedWithoutAToken(t *testing.T) {
	srv := newUIServer(t)
	if rec := serve(srv, unauthenticated(srv, http.MethodGet, "/", nil)); rec.Code != http.StatusOK {
		t.Fatalf("code=%d, want the shell", rec.Code)
	}
	if rec := serve(srv, unauthenticated(srv, http.MethodGet, "/assets/index-abc123.js", nil)); rec.Code != http.StatusOK {
		t.Fatalf("asset code=%d, want 200", rec.Code)
	}
}

// Every /api call needs the header, reads and writes alike, in both modes, and
// nothing is written without it.
func TestTheAPINeedsTheHeader(t *testing.T) {
	for mode, srv := range bothModes(t) {
		before := configFile(t, srv)
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/bundle", ""},
			{http.MethodGet, "/api/tree", ""},
			{http.MethodGet, "/api/entry/notes/a.md", ""},
			{http.MethodGet, "/api/events", ""},
			{http.MethodPost, "/api/board", `{"id":"pwned","path":"/","name":"Pwned"}`},
			{http.MethodPut, "/api/board/root", `{"name":"Pwned"}`},
			{http.MethodPost, "/api/refresh", `{}`},
			{http.MethodPut, "/api/checkbox/notes/a.md", `{"line":6,"done":true,"version":1}`},
			{http.MethodPut, "/api/card/root/notes/a.md", `{"value":"done","version":1}`},
			{http.MethodPost, "/api/git/fetch", `{}`},
		} {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			rec := serve(srv, unauthenticated(srv, tc.method, tc.path, body))
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s: %s %s: code=%d, want 401", mode, tc.method, tc.path, rec.Code)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("%s: %s %s: Cache-Control=%q, want no-store", mode, tc.method, tc.path, got)
			}
		}
		if after := configFile(t, srv); after != before {
			t.Errorf("%s: the bundle was written without the header", mode)
		}
		// The stream is refused before any of it is written.
		events := serve(srv, unauthenticated(srv, http.MethodGet, "/api/events", nil))
		if ct := events.Header().Get("Content-Type"); strings.HasPrefix(ct, "text/event-stream") {
			t.Errorf("%s: /api/events: Content-Type=%q, want a refusal rather than a stream", mode, ct)
		}
	}
}

// The same calls with the app's header go through, so the fence is not simply
// refusing everything.
func TestTheHeaderOpensTheAPI(t *testing.T) {
	for mode, srv := range bothModes(t) {
		for _, tc := range []struct{ method, path, body string }{
			{http.MethodGet, "/api/bundle", ""},
			{http.MethodGet, "/api/tree", ""},
			{http.MethodGet, "/api/entry/notes/a.md", ""},
			{http.MethodGet, "/api/git", ""},
			{http.MethodPost, "/api/refresh", "{}"},
			{http.MethodPut, "/api/checkbox/notes/a.md", `{"line":10,"done":true,"version":1}`},
		} {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			rec := serve(srv, withHeader(srv, unauthenticated(srv, tc.method, tc.path, body)))
			if rec.Code != http.StatusOK {
				t.Errorf("%s: %s %s: code=%d, want 200", mode, tc.method, tc.path, rec.Code)
			}
		}
	}
}

// On loopback the header's value is not checked: any value opens the API, and
// no token exists to print.
func TestOnLoopbackAnyValueOpensTheAPI(t *testing.T) {
	srv := newTestServer(t)
	if srv.networked() {
		t.Fatal("a loopback server created a token")
	}
	for _, value := range []string{"local", "x", strings.Repeat("0", 64)} {
		r := unauthenticated(srv, http.MethodGet, "/api/bundle", nil)
		r.Header.Set(tokenHeader, value)
		if rec := serve(srv, r); rec.Code != http.StatusOK {
			t.Errorf("value %q: code=%d, want 200", value, rec.Code)
		}
	}
}

// On a network bind only this run's token opens the API: not `local`, not
// another run's token, not an empty value.
func TestOnTheNetworkOnlyTheTokenOpensTheAPI(t *testing.T) {
	one := newNetworkServer(t)
	two := New(one.store, one.ui, "0.0.0.0", 0)
	if !one.networked() || one.token == two.token {
		t.Fatalf("tokens %q and %q, want two different ones", one.token, two.token)
	}
	for _, value := range []string{"", "local", one.token, strings.ToUpper(two.token)} {
		r := unauthenticated(two, http.MethodGet, "/api/tree", nil)
		r.Header.Set(tokenHeader, value)
		if rec := serve(two, r); rec.Code != http.StatusUnauthorized {
			t.Errorf("value %q: code=%d, want 401", value, rec.Code)
		}
	}
}

// On loopback the address is checked on every path, before the header, and is
// the client's second state: the header was never the problem.
func TestHostIsCheckedFirstAndOnEveryPath(t *testing.T) {
	srv := newTestServer(t)
	srv.port = 8080 // the address the terminal would have printed

	// The name is what matters, so every loopback spelling answers whatever the
	// port: the default one, ours, or the Vite dev server's.
	for _, host := range []string{
		"localhost:8080", "127.0.0.1:8080", "LOCALHOST:8080", "[::1]:8080",
		"localhost", "127.0.0.1", "[::1]", "localhost:5173", "127.0.0.1:9999",
	} {
		r := withHeader(srv, unauthenticated(srv, http.MethodGet, "/api/bundle", nil))
		r.Host = host
		if rec := serve(srv, r); rec.Code != http.StatusOK {
			t.Errorf("Host %q: code=%d, want 200", host, rec.Code)
		}
	}

	for _, host := range []string{
		"evil.example",              // a rebinding attempt
		"evil.example:8080",         // ... on our port, which changes nothing
		"127.0.0.1.evil.example",    // a name that merely starts locally
		"localhost.evil.example:80", // the same, with a port
		"",                          // empty: to a listener, every interface
		":8080",                     // a port and no name at all
		"[::1]evil.example",         // a loopback literal with a name after it
		"[::1]:8080evil",            // ... or after its port
		"localhost:",                // a colon and no port
		"localhost:http",            // a port that is not a number
	} {
		for _, path := range []string{"/", "/api/bundle", "/raw/index.md"} {
			r := unauthenticated(srv, http.MethodGet, path, nil)
			r.Host = host
			if rec := serve(srv, r); rec.Code != http.StatusMisdirectedRequest {
				t.Errorf("Host %q on %s: code=%d, want 421", host, path, rec.Code)
			}
		}
	}

	// Checked first, so a bad Host is never reported as a missing header.
	r := unauthenticated(srv, http.MethodGet, "/api/bundle", nil)
	r.Host = "evil.example"
	if rec := serve(srv, r); rec.Code != http.StatusMisdirectedRequest {
		t.Errorf("no header and a bad Host: code=%d, want 421", rec.Code)
	}
}

// On a network bind the machine is reached by its IP or its name, so there is
// no Host check: the token is what protects it.
func TestOnTheNetworkAnyHostIsAnswered(t *testing.T) {
	srv := newNetworkServer(t)
	for _, host := range []string{"192.168.1.10:8080", "wiki.lan", "localhost:8080"} {
		r := withHeader(srv, unauthenticated(srv, http.MethodGet, "/api/bundle", nil))
		r.Host = host
		if rec := serve(srv, r); rec.Code != http.StatusOK {
			t.Errorf("Host %q: code=%d, want 200", host, rec.Code)
		}
		r = unauthenticated(srv, http.MethodGet, "/api/bundle", nil)
		r.Host = host
		if rec := serve(srv, r); rec.Code != http.StatusUnauthorized {
			t.Errorf("Host %q without the token: code=%d, want 401", host, rec.Code)
		}
	}
}

// `/raw` is unchanged: a file an entry links to is served with no header at all,
// because an `<img src>` cannot carry one. The Host check is what guards it.
func TestRawIsStillServedWithoutTheToken(t *testing.T) {
	srv, _ := newAssetServer(t)
	if rec := serve(srv, unauthenticated(srv, http.MethodGet, "/raw/notes/diagram.png", nil)); rec.Code != http.StatusOK {
		t.Errorf("linked image: code=%d, want 200", rec.Code)
	}
	// And reachability still follows the bundle's references, not the directory.
	if rec := serve(srv, unauthenticated(srv, http.MethodGet, "/raw/.env", nil)); rec.Code != http.StatusNotFound {
		t.Errorf("an unlinked file: code=%d, want 404", rec.Code)
	}
}

// Framing and referrer policy are app-wide; caching is off on the API.
func TestSecurityHeadersAreOnEveryResponse(t *testing.T) {
	srv := newTestServer(t)
	for _, tc := range []struct {
		path       string
		authorized bool
		noStore    bool
	}{
		{"/", false, false},
		{"/api/bundle", true, true},
		{"/api/bundle", false, true}, // a refusal is not cacheable either
		{"/raw/index.md", false, false},
		{"/api/events", true, true}, // the stream sets its own headers after the fence
	} {
		// Cancelled up front, so the event stream writes its headers and first
		// event and then returns instead of waiting for a change.
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		r := unauthenticated(srv, http.MethodGet, tc.path, nil).WithContext(ctx)
		if tc.authorized {
			withHeader(srv, r)
		}
		rec := serve(srv, r)
		if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("%s: X-Frame-Options=%q", tc.path, got)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != "frame-ancestors 'none'" {
			t.Errorf("%s: Content-Security-Policy=%q", tc.path, got)
		}
		if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("%s: Referrer-Policy=%q", tc.path, got)
		}
		if got := rec.Header().Get("Cache-Control"); (got == "no-store") != tc.noStore {
			t.Errorf("%s: Cache-Control=%q, want no-store=%v", tc.path, got, tc.noStore)
		}
	}
}

// The printed URL is what a browser opens. On loopback it is the plain address,
// so a bookmark keeps working. On a network bind the token is in the fragment,
// in the shape the client insists on — 64 lowercase hex characters, nothing
// else. Both halves pin that form independently, and the failure it would hide
// is a correct server and a correct client that never meet.
func TestThePrintedURLIsOneTheServerAnswers(t *testing.T) {
	local := New(newTestServer(t).store, nil, "localhost", 8080)
	if url := local.URL(); url != "http://localhost:8080/" {
		t.Errorf("loopback URL()=%q, want http://localhost:8080/", url)
	}

	srv := New(newTestServer(t).store, nil, "192.168.1.10", 8080)
	url := srv.URL()
	if !strings.HasPrefix(url, "http://192.168.1.10:8080/#t=") {
		t.Fatalf("URL()=%q, want http://192.168.1.10:8080/#t=<token>", url)
	}
	fragment := strings.TrimPrefix(url[strings.Index(url, "#t="):], "#t=")
	if len(fragment) != 64 || strings.ToLower(fragment) != fragment || strings.Trim(fragment, "0123456789abcdef") != "" {
		t.Fatalf("fragment=%q, want exactly 64 lowercase hex characters", fragment)
	}
	r := unauthenticated(srv, http.MethodGet, "/api/bundle", nil)
	r.Host = "192.168.1.10:8080"
	r.Header.Set(tokenHeader, fragment)
	if rec := serve(srv, r); rec.Code != http.StatusOK {
		t.Errorf("the printed token answered %d", rec.Code)
	}
}

// A token is 32 random bytes as hex, and two runs never agree.
func TestTokensAreLongRandomHex(t *testing.T) {
	seen := map[string]bool{}
	for range 8 {
		tok := newSecret()
		if len(tok) != 64 || strings.ToLower(tok) != tok || strings.Trim(tok, "0123456789abcdef") != "" {
			t.Fatalf("token %q is not 64 lowercase hex characters", tok)
		}
		if seen[tok] {
			t.Fatal("two tokens were equal")
		}
		seen[tok] = true
	}
}

// --- helpers ----------------------------------------------------------------

// newUIServer is a server with a built frontend in it, so the shell has
// something to serve.
func newUIServer(t *testing.T) *Server {
	t.Helper()
	srv := newTestServer(t)
	srv.ui = fstest.MapFS{
		"index.html":             {Data: []byte("<!doctype html><div id=root></div>")},
		"assets/index-abc123.js": {Data: []byte("console.log(1)")},
	}
	return srv
}

// configFile is the bundle's wiki.toml, the thing a write from another page would
// have appended to.
func configFile(t *testing.T, srv *Server) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(srv.store.Dir, "wiki.toml"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The token authenticates in the header only. A query string is the shape that
// comes back the moment something pastes a token into an address, and a URL is
// copied, bookmarked and logged: `?t=` stays as dead on /api as it was before.
func TestTheTokenIsNotAcceptedInAQuery(t *testing.T) {
	srv := newNetworkServer(t)
	for _, target := range []string{
		"/api/bundle?t=" + srv.token,
		"/api/tree?t=" + srv.token,
		"/api/events?t=" + srv.token,
		"/api/bundle?token=" + srv.token,
		"/api/bundle?k=" + srv.token,
	} {
		if code := serve(srv, unauthenticated(srv, http.MethodGet, target, nil)).Code; code != http.StatusUnauthorized {
			t.Errorf("GET %s: code=%d, want 401", target, code)
		}
	}
}

// Nothing emits a CORS header, and a preflight gets nothing useful: an
// Access-Control-Allow-* for any origin would let another page read the API once
// it found a way to send the token.
func TestNoCORSIsEverOffered(t *testing.T) {
	srv := newTestServer(t)
	for _, tc := range []struct {
		method string
		origin string
	}{
		{http.MethodGet, "http://evil.example"},
		{http.MethodPost, "http://evil.example"},
		{http.MethodOptions, "http://evil.example"},
		{http.MethodGet, "null"},
	} {
		r := withHeader(srv, unauthenticated(srv, tc.method, "/api/bundle", strings.NewReader("{}")))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Access-Control-Request-Method", http.MethodPost)
		rec := serve(srv, r)
		for name := range rec.Header() {
			if strings.HasPrefix(strings.ToLower(name), "access-control-") {
				t.Errorf("%s from %s: %s: %s", tc.method, tc.origin, name, rec.Header().Get(name))
			}
		}
		// A preflight is not a route, and a refusal is not something a browser
		// can proceed from.
		if tc.method == http.MethodOptions && rec.Code == http.StatusOK {
			t.Errorf("OPTIONS: code=200, want nothing useful")
		}
	}
}

// An unclean spelling of an /api path is not an /api path to the fence, so it
// must not reach a handler either: the mux answers it with a redirect to the
// clean path, which the fence then guards. Nothing of the bundle is in the reply.
func TestUncleanAPIPathsOnlyRedirect(t *testing.T) {
	srv := newTestServer(t)
	for _, target := range []string{"//api/bundle", "/./api/bundle", "/api/../api/bundle"} {
		r := unauthenticated(srv, http.MethodGet, "/", nil)
		r.URL.Path = target
		rec := serve(srv, r)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), `"version"`) {
			t.Errorf("%s: code=%d body=%q, want no bundle without the token", target, rec.Code, rec.Body.String())
		}
		if rec.Code >= 300 && rec.Code < 400 && rec.Header().Get("Location") != "/api/bundle" {
			t.Errorf("%s: redirected to %q, want the clean path", target, rec.Header().Get("Location"))
		}
	}

	// The same for /raw on a network bind, where the cookie is the gate: an
	// unclean spelling must not serve the file without it.
	assets, _ := newAssetServer(t)
	network := New(assets.store, nil, "0.0.0.0", 0)
	for _, target := range []string{"//raw/notes/diagram.png", "/./raw/notes/diagram.png"} {
		r := unauthenticated(network, http.MethodGet, "/", nil)
		r.URL.Path = target
		rec := serve(network, r)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "PNG") {
			t.Errorf("%s: code=%d body=%q, want no file without the cookie", target, rec.Code, rec.Body.String())
		}
		if rec.Code >= 300 && rec.Code < 400 && rec.Header().Get("Location") != "/raw/notes/diagram.png" {
			t.Errorf("%s: redirected to %q, want the clean path", target, rec.Header().Get("Location"))
		}
	}
}

// The two writes the header was built to stop, sent the way the proved attack
// sent them, to a loopback server: a `text/plain` body, which a foreign page can
// POST without a preflight, and no custom header, which it cannot add without
// one. Refused with a plain 401 and no `WWW-Authenticate`, which would make a
// browser offer its own login box. Accepted with the header carrying any value,
// so the app's own writes still land.
func TestTheProvedWritesNeedTheHeader(t *testing.T) {
	srv := newBoardServer(t, declaredBoard)
	writes := func() []*http.Request {
		board := unauthenticated(srv, http.MethodPost, "/api/board",
			strings.NewReader(`{"id":"second","path":"/backlog","name":"Second"}`))
		card := unauthenticated(srv, http.MethodPut, "/api/card/backlog/backlog/a.md",
			strings.NewReader(fmt.Sprintf(`{"value":"done","version":%d}`, versionOf(t, srv))))
		for _, r := range []*http.Request{board, card} {
			r.Header.Set("Content-Type", "text/plain")
		}
		return []*http.Request{board, card}
	}

	cardFile := func() string {
		b, err := os.ReadFile(filepath.Join(srv.store.Dir, "backlog", "a.md"))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	before, cardBefore := configFile(t, srv), cardFile()
	for _, r := range writes() {
		rec := serve(srv, r)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: code=%d, want 401", r.Method, r.URL.Path, rec.Code)
		}
		if got := rec.Header().Get("WWW-Authenticate"); got != "" {
			t.Errorf("%s %s: WWW-Authenticate=%q, want none", r.Method, r.URL.Path, got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("%s %s: Content-Type=%q, want a JSON body", r.Method, r.URL.Path, ct)
		}
	}
	if configFile(t, srv) != before {
		t.Fatal("wiki.toml was written without the header")
	}
	if cardFile() != cardBefore {
		t.Fatal("backlog/a.md was written without the header")
	}

	// One at a time, because the card's version is read after the board is added.
	board := writes()[0]
	board.Header.Set(tokenHeader, "any value")
	if rec := serve(srv, board); rec.Code != http.StatusOK {
		t.Errorf("POST /api/board with the header: code=%d body=%s", rec.Code, rec.Body)
	}
	card := writes()[1]
	card.Header.Set(tokenHeader, "any value")
	if rec := serve(srv, card); rec.Code != http.StatusOK {
		t.Errorf("PUT /api/card with the header: code=%d body=%s", rec.Code, rec.Body)
	}
}

// Decides the mode: a host wrongly judged local is a network-facing server with
// no token, and one wrongly judged remote asks a local user for a link.
func TestLoopback(t *testing.T) {
	for _, tc := range []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"LOCALHOST", true}, // a flag is typed by hand, so case is ignored
		{"127.0.0.1", true},
		{"127.0.0.53", true}, // the whole 127/8 block, not just .1
		{"::1", true},

		{"0.0.0.0", false},
		{"::", false},
		{"192.168.1.10", false},
		{"example.com", false}, // a name that is not localhost resolves elsewhere
		// Empty means every interface to a listener, which is the least local
		// thing there is — and the easiest to read as "nothing specified".
		{"", false},
	} {
		if got := loopback(tc.host); got != tc.want {
			t.Errorf("loopback(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

// A bind to every interface has no address anyone can open, so the link names
// the machine: its hostname, else its first non-loopback IP, else localhost.
// Never `0.0.0.0`, `::` or an empty host.
func TestLinkHostNamesTheMachineForAnUnspecifiedBind(t *testing.T) {
	named := func() (string, error) { return "wiki-box", nil }
	nameless := func() (string, error) { return "", fmt.Errorf("no hostname") }
	lan := func() ([]net.Addr, error) {
		return []net.Addr{
			&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
			&net.IPNet{IP: net.ParseIP("192.168.1.10"), Mask: net.CIDRMask(24, 32)},
		}, nil
	}
	none := func() ([]net.Addr, error) { return nil, fmt.Errorf("no interfaces") }

	for _, tc := range []struct {
		bind     string
		hostname func() (string, error)
		addrs    func() ([]net.Addr, error)
		want     string
	}{
		// Unspecified: the machine's name, then its LAN IP, then localhost.
		{"0.0.0.0", named, lan, "wiki-box"},
		{"::", named, lan, "wiki-box"},
		{"", named, lan, "wiki-box"},
		{"0.0.0.0", nameless, lan, "192.168.1.10"},
		{"0.0.0.0", nameless, none, "localhost"},
		// Anything else is printed as typed.
		{"localhost", named, lan, "localhost"},
		{"127.0.0.53", named, lan, "127.0.0.53"},
		{"192.168.1.10", named, lan, "192.168.1.10"},
		{"wiki.lan", named, lan, "wiki.lan"},
	} {
		if got := linkHost(tc.bind, tc.hostname, tc.addrs); got != tc.want {
			t.Errorf("linkHost(%q) = %q, want %q", tc.bind, got, tc.want)
		}
	}
}

// On a network bind `/raw` needs the `wikishell_raw_<port>` cookie, which an
// `/api` response that passed the token check sets: an `<img src>` cannot send
// the header, but the browser sends the cookie. Its value is a separate secret,
// never the token, because cookies reach every service on the host; and `/api`
// never accepts it, because a browser sends cookies on another site's requests.
// On loopback `/raw` is unchanged and nothing is set.
func TestOnTheNetworkRawNeedsTheCookie(t *testing.T) {
	assets, _ := newAssetServer(t)
	srv := New(assets.store, nil, "0.0.0.0", 8080)
	raw := func(host string, cookie *http.Cookie) int {
		r := unauthenticated(srv, http.MethodGet, "/raw/notes/diagram.png", nil)
		r.Host = host
		if cookie != nil {
			r.AddCookie(cookie)
		}
		return serve(srv, r).Code
	}
	if code := raw("192.168.1.10:8080", nil); code != http.StatusUnauthorized {
		t.Errorf("no cookie: code=%d, want 401", code)
	}
	// A rebound name gets no further: there is no Host check here, the cookie is the gate.
	if code := raw("evil.example", nil); code != http.StatusUnauthorized {
		t.Errorf("Host evil.example, no cookie: code=%d, want 401", code)
	}
	if code := raw("192.168.1.10:8080", &http.Cookie{Name: srv.rawCookie(), Value: srv.token}); code != http.StatusUnauthorized {
		t.Errorf("the API token as the cookie: code=%d, want 401", code)
	}

	// The cookie comes from an /api call that passed, and only from one.
	if refused := serve(srv, unauthenticated(srv, http.MethodGet, "/api/bundle", nil)); len(refused.Result().Cookies()) != 0 {
		t.Error("a refused /api call set a cookie")
	}
	rec := serve(srv, withHeader(srv, unauthenticated(srv, http.MethodGet, "/api/bundle", nil)))
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("an /api call that passed set %d cookies, want 1", len(cookies))
	}
	set := cookies[0]
	// Named per port, so two WikiShells on one host never overwrite each other.
	if set.Name != "wikishell_raw_8080" {
		t.Errorf("cookie name %q, want wikishell_raw_8080", set.Name)
	}
	if set.Path != "/raw" || !set.HttpOnly || set.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie %+v, want Path=/raw, HttpOnly, SameSite=Strict", set)
	}
	if set.Value == srv.token || len(set.Value) != 64 {
		t.Errorf("cookie value is the token or not a 64-character secret")
	}
	if code := raw("192.168.1.10:8080", set); code != http.StatusOK {
		t.Errorf("with the cookie: code=%d, want 200", code)
	}
	// A forged cookie of the same name, planted by another service on this host
	// and sent first, does not hide the real one.
	forged := unauthenticated(srv, http.MethodGet, "/raw/notes/diagram.png", nil)
	forged.AddCookie(&http.Cookie{Name: set.Name, Value: strings.Repeat("0", 64)})
	forged.AddCookie(set)
	if code := serve(srv, forged).Code; code != http.StatusOK {
		t.Errorf("a forged cookie before the real one: code=%d, want 200", code)
	}

	// /api never accepts the cookie in place of the header.
	r := unauthenticated(srv, http.MethodGet, "/api/bundle", nil)
	r.AddCookie(set)
	if code := serve(srv, r).Code; code != http.StatusUnauthorized {
		t.Errorf("/api with only the cookie: code=%d, want 401", code)
	}

	// Loopback: no cookie set, none needed.
	local, _ := newAssetServer(t)
	if c := serve(local, withHeader(local, unauthenticated(local, http.MethodGet, "/api/bundle", nil))).Result().Cookies(); len(c) != 0 {
		t.Errorf("a loopback server set %v", c)
	}
}

// The 401 says what this mode needs.
func TestTheRefusalSaysWhatTheModeNeeds(t *testing.T) {
	for mode, want := range map[string]string{
		"loopback": "send the X-Wikishell-Token header (any value)",
		"network":  "this needs the token from the link WikiShell printed",
	} {
		srv := bothModes(t)[mode]
		rec := serve(srv, unauthenticated(srv, http.MethodGet, "/api/bundle", nil))
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("%s: body=%q, want %q", mode, rec.Body.String(), want)
		}
	}
}
