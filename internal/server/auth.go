package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
)

// This file is the fence in front of the mux. The contract is one rule:
//
//	Every /api request carries X-Wikishell-Token. If the server has a token
//	(network bind), the value must equal it.
//
// Missing or wrong is `401`. The rest depends on where the server listens,
// because the threat is different:
//
//   - **On a loopback address** (the default) only this machine can connect,
//     so the danger is a web page open in the browser. It cannot send the
//     header to another origin without a CORS preflight that WikiShell never
//     approves, so any value will do. The `Host` must be a loopback name,
//     which stops DNS rebinding (`421`). No token is created, so the plain
//     address works and bookmarks keep working.
//   - **On any other address** other machines can connect, so the header must
//     carry this run's token, created at start and printed in the link. There
//     is no `Host` check: the machine is reached by its IP or its name, and the
//     token is what protects it.
//
// `/raw` serves files to `<img>` tags, which cannot set a header. On loopback
// the `Host` check guards it. On a network bind it needs the
// `wikishell_raw_<port>` cookie, a separate secret that every `/api` response
// that passed the check sets, scoped to `/raw`. `/api` never accepts it.

// tokenHeader is the header every API call carries. The client hard-codes the
// same name, so renaming it is a change on both sides.
const tokenHeader = "X-Wikishell-Token"

// loopbackHosts are the spellings a browser may put in `Host` for an address on
// this machine. `localhost` and `127.0.0.1` are different hosts to a browser and
// the same machine to us, and `[::1]` keeps its brackets verbatim in `Host`.
var loopbackHosts = []string{"127.0.0.1", "localhost", "[::1]"}

// loopback reports whether a host is reachable only from this machine. An empty
// host is not: to a listener it means every interface.
func loopback(host string) bool {
	host = strings.ToLower(host)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// newSecret creates a secret for a network bind, the API token or the `/raw`
// cookie: 32 random bytes, as 64 lowercase hex characters.
//
// Hex because it travels in a header and in a URL fragment, and hex is the one
// spelling that means the same thing in both: nothing escapes it, nothing
// decodes it, and no client has to agree with the server about normalisation.
func newSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A machine with no working random source cannot serve this safely, and
		// carrying on with a predictable token would be worse than not starting.
		panic("wikishell: cannot read random bytes for a secret: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// URL is the address to open: the one the terminal prints.
//
// On a network bind it carries the token in the fragment, so the token never
// reaches the server, a log line or a `Referer`; the app clears it from the
// address bar on arrival. Valid for the life of the process, so a second tab
// and a reloaded address both work.
func (s *Server) URL() string {
	u := "http://" + net.JoinHostPort(s.linkHost, strconv.Itoa(s.port)) + "/"
	if s.networked() {
		u += "#t=" + s.token
	}
	return u
}

// hostAllowed reports whether a `Host` header names this machine: a loopback
// name (plus whichever host the listener was asked to bind), whatever the port.
//
// The name is the whole check. DNS rebinding works by making a name resolve to
// 127.0.0.1 — the port it then asks for is whatever port the victim's browser
// remembers, so refusing by port protects nothing and breaks a real shape: under
// `vite dev` the Host is the dev server's port, and a check that refused it is
// one somebody loosens later. The port is ignored; an empty Host is still
// refused, because an empty one is not a name at all.
//
// Compared case-insensitively because `Host` arrives verbatim — a browser may
// send `LOCALHOST:8080` — and an IPv6 literal keeps its brackets.
func (s *Server) hostAllowed(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	name, port := host, ""
	if strings.HasPrefix(host, "[") {
		// `[::1]` or `[::1]:8080`: the name is up to the closing bracket.
		if end := strings.Index(host, "]"); end >= 0 {
			name, port = host[:end+1], host[end+1:]
		}
	} else if colon := strings.LastIndex(host, ":"); colon >= 0 {
		name, port = host[:colon], host[colon:]
	}
	// Whatever follows the name is nothing or a port: `[::1]evil.example` is
	// not a loopback name with something after it, it is not a Host at all.
	if port != "" && !isPort(port) {
		return false
	}
	for _, known := range s.hosts {
		if name == known {
			return true
		}
	}
	return false
}

// linkHost is the host to print in the URL for a listener bound to bindHost.
//
// A bind to every interface (`0.0.0.0`, `::` or an empty host) has no address
// anyone can open, so the link names this machine instead: its hostname, or,
// if that cannot be read, its first non-loopback IP. `localhost` is the last
// resort, for a machine with neither. Any other bind is printed as typed.
//
// The two lookups are parameters so a test can make them fail.
func linkHost(bindHost string, hostname func() (string, error), addrs func() ([]net.Addr, error)) string {
	if ip := net.ParseIP(bindHost); bindHost != "" && (ip == nil || !ip.IsUnspecified()) {
		return bindHost
	}
	if name, err := hostname(); err == nil && name != "" {
		return name
	}
	if list, err := addrs(); err == nil {
		for _, a := range list {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.IsGlobalUnicast() {
				return n.IP.String()
			}
		}
	}
	return "localhost"
}

// rawCookie is the name of the cookie that opens `/raw` on a network bind.
//
// Browsers do not scope cookies by port, so every service on this host receives
// it. Two consequences: its value is a separate secret, never the API token,
// so a neighbouring service that reads it gains `/raw` and nothing else; and its
// name carries the port, so two WikiShells on one host never overwrite each
// other's.
func (s *Server) rawCookie() string {
	return "wikishell_raw_" + strconv.Itoa(s.port)
}

// networked reports whether the server is on a network address, which is the
// mode with a token. Loopback has none.
func (s *Server) networked() bool {
	return s.token != ""
}

// tokenAllowed reports whether the request carries the header the bind asks for.
//
// On loopback any non-empty value is enough: what matters is that the header is
// there at all, because a page on another origin cannot add it. On a network
// bind it must be this run's token.
func (s *Server) tokenAllowed(r *http.Request) bool {
	got := r.Header.Get(tokenHeader)
	if !s.networked() {
		return got != ""
	}
	return matches(got, s.token)
}

// rawAllowed reports whether a `/raw` request may be served: always on
// loopback, and on a network bind only with the cookie an `/api` call set.
// The cookie gates `/raw` only: `/api` never reads it, because a browser sends
// a cookie on requests another site's page makes, which is the hole the header
// closes.
func (s *Server) rawAllowed(r *http.Request) bool {
	if !s.networked() {
		return true
	}
	// Any cookie of that name, not only the first: another service on this host
	// can plant one with a more specific path, which the browser sends first.
	for _, c := range r.CookiesNamed(s.rawCookie()) {
		if matches(c.Value, s.rawSecret) {
			return true
		}
	}
	return false
}

// matches reports whether got is the secret want. Length is checked first and
// in the open: both are a fixed 64 characters, so a different length is a
// wrong-shaped value. The compare itself is constant time, so a wrong value
// leaks nothing about how wrong it is.
func matches(got, want string) bool {
	return len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// refusal is the `401` body, saying what this mode needs.
func (s *Server) refusal() errorBody {
	if s.networked() {
		return errorBody{"this needs the token from the link WikiShell printed"}
	}
	return errorBody{"send the X-Wikishell-Token header (any value)"}
}

// ServeHTTP is the fence, then the mux.
//
// The check is here, around every route, rather than in the handlers: the
// handlers are where routes are added, and a per-route check is how the next one
// is written without it.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Refused responses were still framed, so a page that manages to load
	// anything from here cannot frame it, and a `401` body cannot be cached.
	// `frame-ancestors` is the current spelling of the same rule; both are set
	// because a browser honours whichever it knows.
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")

	// The address first, and only on loopback: a request for a host we do not
	// answer to is not a client with a header problem, and telling it so would
	// be a lie.
	if !s.networked() && !s.hostAllowed(r.Host) {
		writeJSON(w, http.StatusMisdirectedRequest, errorBody{"unexpected Host; use the address the terminal printed"})
		return
	}

	switch {
	case isUnder(r.URL.Path, "/api"):
		w.Header().Set("Cache-Control", "no-store")
		if !s.tokenAllowed(r) {
			writeJSON(w, http.StatusUnauthorized, s.refusal())
			return
		}
		if s.networked() {
			// Hands the browser the `/raw` secret, for `<img src>`, which
			// fetches without a header. HttpOnly, so no script reads it back;
			// SameSite=Strict, so no other site's page sends it; scoped to
			// `/raw`, so it opens nothing else. No `Secure`: there is no TLS.
			http.SetCookie(w, &http.Cookie{
				Name: s.rawCookie(), Value: s.rawSecret, Path: "/raw",
				HttpOnly: true, SameSite: http.SameSiteStrictMode,
			})
		}
	case isUnder(r.URL.Path, "/raw"):
		if !s.rawAllowed(r) {
			writeJSON(w, http.StatusUnauthorized, s.refusal())
			return
		}
	}

	s.mux.ServeHTTP(w, r)
}

// isUnder reports whether a path is root (`/api`, `/raw`) or below it.
func isUnder(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+"/")
}

// hostAllowlist is every spelling this server answers to: the loopback ones plus
// the host it was asked to bind.
//
// The bind host has to be included rather than derived from the listener's
// address: `net.Listen("tcp", "localhost:0")` reports `127.0.0.1:...`, so a
// `localhost` bind that trusted the resolved address would answer `421` to the
// URL it had just printed. A loopback IP other than 127.0.0.1 (`127.0.0.53`) is
// the same problem in the other direction.
func hostAllowlist(bindHost string) []string {
	hosts := append([]string{}, loopbackHosts...)
	host := strings.ToLower(strings.TrimSpace(bindHost))
	if host == "" {
		return hosts
	}
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		// `Host` keeps an IPv6 literal's brackets.
		host = "[" + host + "]"
	}
	for _, known := range hosts {
		if known == host {
			return hosts
		}
	}
	return append(hosts, host)
}

// isPort reports whether s is `:` followed by one or more digits.
func isPort(s string) bool {
	if len(s) < 2 || s[0] != ':' {
		return false
	}
	for _, c := range s[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
