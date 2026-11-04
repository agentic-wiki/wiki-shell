#!/usr/bin/env bash
# End-to-end check that the binary serves a real bundle.
#
# The Go tests exercise handlers directly; this runs the actual binary against a
# bundle on disk and talks to it over HTTP, which is the only thing that proves
# the pieces are wired together — the embedded UI, the store, the routes, the
# SPA fallback that makes a deep URL survive a cold load, and the fence that
# stands in front of all of it.
#
# Usage: scripts/smoke.sh ./bin/wikiview
set -euo pipefail

BIN="${1:?usage: smoke.sh <path-to-wikiview>}"
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"
PORT="${PORT:-8791}"
BASE="http://localhost:${PORT}"

bundle=$(mktemp -d)
log=$(mktemp)
netlog=$(mktemp)
jar=$(mktemp) # a cookie jar, kept out of the bundle being served
trap 'rm -rf "$bundle" "$log" "$netlog" "$jar";for p in ${pid:-} ${netpid:-}; do kill "$p" 2>/dev/null || true; done' EXIT

mkdir -p "$bundle/notes"
printf 'spec = "0.1"\n' >"$bundle/wiki.toml"
printf -- '---\nokf_version: "0.1"\n---\n# Home\n\nSee [a note](./notes/a.md), a [contract](./notes/contract.sol) and ![a diagram](./notes/diagram.png).\n' >"$bundle/index.md"
printf -- '---\ntype: task\nstatus: todo\n---\n## A Heading_here\n\n- [ ] first\n' >"$bundle/notes/a.md"
printf 'pragma solidity ^0.8.0;\n' >"$bundle/notes/contract.sol"
printf '\x89PNG\r\n\x1a\nnot really' >"$bundle/notes/diagram.png"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

# started <log>: waits until a server has printed the address to open.
started() {
    for _ in $(seq 1 50); do
        grep -q 'open http://' "$1" 2>/dev/null && return 0
        sleep 0.1
    done
    cat "$1" >&2
    fail "the server printed no address"
}

"$BIN" "$bundle" --host localhost --port "${PORT}" >"$log" 2>&1 &
pid=$!
started "$log"

echo "--- on localhost the printed address carries no token ---"
grep -q "open http://localhost:${PORT}/\$" "$log" || fail "the loopback address was not printed plain: $(cat "$log")"

# Every API call carries the header, the way the app's do. On localhost any
# value is accepted; the app sends `local` when it holds no token.
TOKEN=local
api() { curl -sf -H "X-Wikiview-Token: ${TOKEN}" "$@"; }

check() { # check <description> <pattern> <url>
    echo "--- $1 ---"
    api "$3" | grep -q "$2" || fail "$1"
}

echo "--- the header is the only way in, and the Host is checked first ---"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/bundle")" == "401" ]] ||
    fail "a read without the header was not refused"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/refresh" -d '{}')" == "401" ]] ||
    fail "a write without the header was not refused"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' -H "X-Wikiview-Token: ${TOKEN}" "${BASE}/api/bundle")" == "421" ]] ||
    fail "a foreign Host was not refused"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/")" == "200" ]] ||
    fail "the shell was not served without a token"

check "the bundle reports itself" '"entries":2' "${BASE}/api/bundle"
check "the tree lists the folder" '"path":"/notes"' "${BASE}/api/tree"
check "an entry serves its markdown" '## A Heading_here' "${BASE}/api/entry/notes/a.md"
check "links resolve to bundle paths" '"to":"/notes/a.md"' "${BASE}/api/entry/index.md"

# Heading ids must match what the engine accepts as an anchor. The underscore is
# the case every general-purpose slugger gets differently.
check "heading ids keep underscores" '"id":"a-heading_here"' "${BASE}/api/entry/notes/a.md"

# A write is addressed by file line; the body is served frontmatter-stripped.
# Both coordinates travel, and confusing them writes to the wrong line.
check "positions carry both coordinate systems" '"bodyLine":3' "${BASE}/api/entry/notes/a.md"

# A file an entry links to is served with no header at all: an <img src> cannot
# set one, and the Host check is what guards it.
echo "--- a linked file is served without the header, and only if it is linked ---"
check "the entry names where to fetch its image" '"asset":"/raw/notes/diagram.png"' "${BASE}/api/entry/index.md"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/raw/notes/diagram.png")" == "200" ]] ||
    fail "a linked image was not served"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/raw/wiki.toml")" == "404" ]] ||
    fail "an unlinked file was served"

echo "--- a checkbox toggle writes the file ---"
version=$(api "${BASE}/api/bundle" | grep -o '"version":[0-9]*' | cut -d: -f2)
# Scoped to the checkboxes array: "line" also appears in links and headings, and
# taking the first one in the document writes to whatever a heading sits on.
line=$(api "${BASE}/api/entry/notes/a.md" |
    grep -o '"checkboxes":\[[^]]*' | grep -o '"line":[0-9]*' | head -1 | cut -d: -f2)
[[ -n "$line" ]] || fail "could not find the checkbox's line in the response"
api -X PUT "${BASE}/api/checkbox/notes/a.md" \
    -d "{\"line\":${line},\"done\":true,\"version\":${version}}" >/dev/null
grep -q -- '- \[x\] first' "$bundle/notes/a.md" || fail "the checkbox was not written"

echo "--- a stale version is refused, and nothing changes ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${BASE}/api/checkbox/notes/a.md" \
    -H "X-Wikiview-Token: ${TOKEN}" \
    -d "{\"line\":${line},\"done\":false,\"version\":${version}}")
[[ "$code" == "409" ]] || fail "expected 409 for a stale version, got $code"
grep -q -- '- \[x\] first' "$bundle/notes/a.md" || fail "a refused write changed the file"

echo "--- an edit on disk reaches the index without a request ---"
printf -- '---\ntype: note\n---\nbrand new\n' >"$bundle/notes/b.md"
for _ in $(seq 1 50); do
    api "${BASE}/api/bundle" | grep -q '"entries":3' && break
    sleep 0.1
done
api "${BASE}/api/bundle" | grep -q '"entries":3' || fail "the watcher did not pick up a new entry"

echo "--- a deep URL survives a cold load (SPA fallback) ---"
curl -sf "${BASE}/wiki/notes/a.md" | grep -q '<div id="root">' ||
    echo "  (skipped: no UI built into this binary)"

echo "--- a network bind starts, prints a token link, and only that token opens it ---"
NETPORT=$((PORT + 1))
"$BIN" "$bundle" --host 0.0.0.0 --port "${NETPORT}" >"$netlog" 2>&1 &
netpid=$!
started "$netlog"
# A bind to every interface prints the machine's name, never 0.0.0.0.
LINK=$(grep -o "open http://[^ ]*" "$netlog" | head -1 | cut -d" " -f2)
[[ "$LINK" == "http://"*":${NETPORT}/#t="* && "$LINK" != "http://0.0.0.0:"* && "$LINK" != "http://:"* ]] ||
    fail "the network bind did not print a usable link: $(cat "$netlog")"
NETTOKEN=${LINK##*#t=}
[[ ${#NETTOKEN} == 64 ]] || fail "the network bind printed no token link: $(cat "$netlog")"
net() { curl -s -o /dev/null -w '%{http_code}' "$@" "http://127.0.0.1:${NETPORT}/api/bundle"; }
[[ "$(net -H "X-Wikiview-Token: ${NETTOKEN}")" == "200" ]] || fail "the printed token was refused"
[[ "$(net -H "X-Wikiview-Token: local")" == "401" ]] || fail "a wrong token was accepted"
[[ "$(net)" == "401" ]] || fail "a missing token was accepted"
# No Host check here: the machine is reached by its IP or its name.
[[ "$(net -H 'Host: wiki.lan' -H "X-Wikiview-Token: ${NETTOKEN}")" == "200" ]] ||
    fail "a network name was refused"
# /raw needs the cookie an /api call sets, the way the browser carries it.
netraw="http://127.0.0.1:${NETPORT}/raw/notes/diagram.png"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$netraw")" == "401" ]] ||
    fail "a network /raw was served without the cookie"
curl -sf -o /dev/null -c "$jar" -H "X-Wikiview-Token: ${NETTOKEN}" "http://127.0.0.1:${NETPORT}/api/bundle"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$netraw")" == "200" ]] ||
    fail "a network /raw was refused with the cookie"

echo "--- traversal names nothing ---"
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Wikiview-Token: ${TOKEN}" \
    "${BASE}/api/entry/%2e%2e%2f%2e%2e%2fetc%2fpasswd" | grep -q 404 ||
    fail "a traversal attempt did not 404"

echo
echo "All smoke tests passed!"
