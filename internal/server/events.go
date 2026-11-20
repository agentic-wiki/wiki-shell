package server

import (
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/agentic-wiki/wiki-shell/internal/config"
	"github.com/agentic-wiki/wiki-shell/internal/store"
)

// broker fans a version number out to connected clients.
//
// A version, never a payload. Sending the changed entry would mean the server
// deciding what each client cares about, and a client that missed one message
// being permanently behind. A version says only "you are stale"; the client
// refetches what it is actually looking at, so a client that missed ten events
// pulls once and is correct again. There is no replay to design and no ordering
// to get wrong.
type broker struct {
	mu      sync.Mutex
	clients map[chan uint64]struct{}
	// closed when the server is shutting down. An SSE handler blocks until its
	// client goes away, and a client on a working connection never does — so
	// without a second thing to wait on, every open stream would hold
	// http.Server.Shutdown open until its timeout expired.
	closing chan struct{}
}

func newBroker() *broker {
	return &broker{clients: map[chan uint64]struct{}{}, closing: make(chan struct{})}
}

func (b *broker) subscribe() chan uint64 {
	// Buffered by one: a client that is mid-write when a version arrives gets
	// the newer number without the publisher waiting for it. Coalescing is
	// correct here — versions are absolute, not increments, so the latest one
	// makes any it replaced irrelevant.
	ch := make(chan uint64, 1)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *broker) unsubscribe(ch chan uint64) {
	b.mu.Lock()
	delete(b.clients, ch)
	b.mu.Unlock()
}

// publish never blocks: a slow or wedged client must not stall a rebuild or
// every other client. It drops the older pending version instead, which loses
// nothing because the newer one supersedes it.
func (b *broker) publish(version uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.clients {
		select {
		case ch <- version:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- version:
			default:
			}
		}
	}
}

func (b *broker) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.clients)
}

// RebuildAndNotify re-reads the bundle and tells every listener, as one step.
//
// One step because they are one: taken apart, two of them overlapping each read
// the version *after* both had landed, so one version was announced twice and
// the one between it was never announced at all. Whoever is watching a terminal
// was then told a rebuild happened that they could not account for.
//
// The lock is only around this pair. Rebuild has its own, and a request reading
// the index takes none.
func (s *Server) RebuildAndNotify() error {
	s.announcing.Lock()
	defer s.announcing.Unlock()

	changed, err := s.store.Rebuild()
	if err != nil {
		return err
	}
	if changed && s.store.View().ConfigMoved {
		if err := s.MigrateConfig(); err != nil {
			return err
		}
	}
	if changed {
		s.Notify()
	}
	return nil
}

// MigrateConfig renames an older wiki's `[tool.wikiview]` tables to
// `[[board]]` and `[[graph]]`, re-reads the bundle when it did, and names what
// it could not move. Run at start and on each change of wiki.toml, so a table
// an older app writes back is renamed again. A file it cannot write is
// reported and left as it is: the config is optional, so serving goes on.
func (s *Server) MigrateConfig() error {
	renamed, err := config.Migrate(s.store.Dir)
	if err != nil {
		log.Printf("wiki.toml: could not rename the [tool.wikiview] tables to [[board]] and [[graph]]: %v", err)
		return nil
	}
	if renamed {
		log.Print("wikishell: renamed [tool.wikiview] tables in wiki.toml to [[board]] and [[graph]]")
		if _, err := s.store.Rebuild(); err != nil {
			return err
		}
	}
	if left := config.LeftBehind(s.store.View().Index.Bundle); left != "" {
		log.Printf("wiki.toml: %s", left)
	}
	return nil
}

// Notify publishes the store's current version to every connected client, and
// says on the console what moved and who was told.
//
// Logged here rather than at each caller because this is the one place a
// version reaches listeners, whether it moved because the watcher saw an edit
// or because a checkbox was ticked through the API. A server you are watching
// in a terminal should account for every version its clients are asked to
// refetch at.
//
// The version comes from the same View the rest of this reads. Passed in, it
// could describe a different rebuild than the one whose `changedAt` is being
// consulted, and then the line names the wrong entries.
func (s *Server) Notify() {
	v := s.store.View()
	// changedAt equals the current version exactly for the entries this rebuild
	// moved, so there is nothing to diff.
	var moved []string
	for path, at := range v.ChangedAt {
		if at == v.Version {
			moved = append(moved, path)
		}
	}
	slices.Sort(moved)
	log.Printf("v%d, %s, %d listening", v.Version, describe(v, moved), s.events.count())

	s.events.publish(v.Version)
}

// listedChanges is how many paths a log line names before it starts counting.
// A `tidy --all` moves hundreds at once, and a terminal full of them buries the
// next thing that happens.
const listedChanges = 5

// describe says why a version moved.
//
// Every reason gets named, because a line that cannot account for a version is
// worse than no line: somebody reading a terminal has to decide whether their
// bundle is fine, and "nothing changed, here is a new version" does not help
// them. A deletion is the case that used to read that way — a removed entry is
// absent from ChangedAt rather than marked in it, so nothing pointed at it.
func describe(v store.View, moved []string) string {
	var parts []string
	if len(moved) > 0 {
		parts = append(parts, summarize(moved))
	}
	if n := len(v.Removed); n > 0 {
		parts = append(parts, "removed "+summarize(v.Removed))
	}
	if v.ConfigMoved {
		parts = append(parts, "wiki.toml")
	}
	if len(parts) == 0 {
		// Reached only if the digest moved for a reason none of the above covers,
		// which would be a bug in the digest rather than something to hide.
		return "unaccounted for"
	}
	return strings.Join(parts, ", ")
}

func summarize(paths []string) string {
	if len(paths) <= listedChanges {
		return strings.Join(paths, " ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(paths[:listedChanges], " "), len(paths)-listedChanges)
}

// Close ends every open event stream.
//
// Called before http.Server.Shutdown, which waits for handlers to return: an
// SSE handler is by design still running, so without this it waits out the
// whole shutdown timeout and reports "context deadline exceeded" on every exit.
// Safe to call more than once.
func (s *Server) Close() {
	s.events.mu.Lock()
	defer s.events.mu.Unlock()
	select {
	case <-s.events.closing:
	default:
		close(s.events.closing)
	}
}

// RemoveShadow deletes the changes view's shadow folder; any later use of it
// fails. Called once the HTTP server has shut down, so a commit still running
// during the shutdown keeps its folder.
func (s *Server) RemoveShadow() {
	if err := s.shadow.Remove(); err != nil {
		log.Printf("could not delete the changes view's shadow folder: %v", err)
	}
}

// heartbeat is how often a quiet stream says it is still there.
//
// The client treats a connection that delivers nothing for twice this as dead
// and reconnects, so a stream that is merely idle must keep speaking: without it
// a healthy reader is torn down and reconnected every half minute. A comment
// line is enough — it carries no data and every SSE reader ignores it.
//
// A variable rather than a constant so a test can watch one arrive without
// waiting fifteen seconds for it.
var heartbeat = 15 * time.Second

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	// Proxies that buffer would defeat the point of streaming.
	w.Header().Set("X-Accel-Buffering", "no")

	ch := s.events.subscribe()
	defer s.events.unsubscribe(ch)

	ping := time.NewTicker(heartbeat)
	defer ping.Stop()

	// The current version up front, so a client that connects after a change
	// discovers it is stale without waiting for the next one.
	writeEvent(w, flusher, s.store.View().Version)

	for {
		select {
		case <-r.Context().Done():
			return // the client went away
		case <-s.events.closing:
			return // the server is shutting down; end the stream so it can
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case v := <-ch:
			writeEvent(w, flusher, v)
		}
	}
}

func writeEvent(w http.ResponseWriter, flusher http.Flusher, version uint64) {
	fmt.Fprintf(w, "event: version\ndata: %d\n\n", version)
	flusher.Flush()
}
