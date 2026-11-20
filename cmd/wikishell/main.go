// Command wikishell serves an agentic-wiki bundle over HTTP.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/agentic-wiki/wiki-shell/internal/config"
	"github.com/agentic-wiki/wiki-shell/internal/server"
	"github.com/agentic-wiki/wiki-shell/internal/store"
	"github.com/agentic-wiki/wiki-shell/internal/watch"
	"github.com/agentic-wiki/wiki-shell/ui"
)

// Version is set at build time via -ldflags "-X main.Version=...", the same way
// the engine does it, so a released binary can say which one it is. A package
// manager needs this: Homebrew's formula test runs the binary and checks the
// version it reports against the version it installed.
var Version = "dev"

func main() {
	opts, err := parseArgs(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return // the flag package has already printed usage
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "wikishell:", err)
		os.Exit(2)
	}
	if opts.version {
		fmt.Println("wikishell", Version)
		return
	}

	if err := run(opts); err != nil {
		fmt.Fprintln(os.Stderr, "wikishell:", err)
		os.Exit(1)
	}
}

type options struct {
	root    string
	host    string
	port    int
	version bool
	edit    bool
}

// parseArgs reads the command line: `wikishell [path] [flags]`, in any order.
//
// The path is positional because there is only one thing to point this at, and
// `wikishell my-kb` reads better than a flag for it. That costs something the
// stdlib does not give for free: flag.Parse stops at the first non-flag
// argument, so `wikishell my-kb --port 3000` would take the path and silently
// serve on 8080 anyway.
//
// So it parses in rounds, peeling off one positional argument each time flags
// run out. Interleaving works in any arrangement, which is the whole reason a
// bigger argument library would have been considered — and this is the part of
// one that this command actually needs.
func parseArgs(args []string) (options, error) {
	fs := flag.NewFlagSet("wikishell", flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprint(fs.Output(), "usage: wikishell [path] [flags]\n\n"+
			"Serves the agentic-wiki bundle at path, or the working directory.\n\n")
		fs.PrintDefaults()
	}
	host := fs.String("host", "localhost", "interface to listen on; any non-loopback address (0.0.0.0 for all) prints a link with a token")
	port := fs.Int("port", 8080, "port to listen on")
	showVersion := fs.Bool("version", false, "print the version and exit")
	edit := fs.Bool("edit", false, "on a network address, let anyone with the link edit pages, commit and push as you (it means nothing on localhost, where editing is always on)")

	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return options{}, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			break
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}

	opts := options{root: ".", host: *host, port: *port, version: *showVersion, edit: *edit}
	// Accepted as a bare word too, matching `wiki version`.
	if len(positional) == 1 && positional[0] == "version" {
		opts.version = true
		return opts, nil
	}
	if len(positional) > 1 {
		return options{}, fmt.Errorf("expected one path, got %d: %s", len(positional), strings.Join(positional, " "))
	}
	if len(positional) == 1 {
		opts.root = positional[0]
	}
	return opts, nil
}

func run(opts options) error {
	s, err := store.Open(opts.root)
	if err != nil {
		return err
	}

	// Listened for before the server is built, because the printed URL needs
	// the port, and with --port 0 it is known only once the socket is open.
	ln, err := net.Listen("tcp", net.JoinHostPort(opts.host, strconv.Itoa(opts.port)))
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := server.New(s, ui.Assets(), opts.host, port)
	if opts.edit {
		srv.AllowEdits()
	}
	if err := srv.MigrateConfig(); err != nil {
		return err
	}
	idx := s.View().Index
	// The address to open. On a network bind it is the one place the token is
	// printed, in the fragment, so it never reaches this server, a request log
	// or a Referer.
	log.Printf("serving %s (%d entries)", s.Dir, len(idx.Entries))
	log.Printf("open %s", srv.URL())
	if notice := srv.EditNotice(); notice != "" {
		log.Print(notice)
	}

	// `wiki` never looks inside `[[board]]` and `[[graph]]`, deliberately, so nothing else will
	// ever tell you that a board points at a folder you renamed or that a key is
	// misspelled. Said once, at startup, and never fatal: this config is
	// optional, and the reader does not need it to work.
	if _, problems := config.Decode(idx.Bundle, idx); len(problems) > 0 {
		for _, p := range problems {
			log.Printf("wiki.toml: %s", p)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The bundle belongs to whoever else is editing it, so the index follows the
	// files rather than waiting to be asked. A rebuild that fails keeps the
	// previous index serving, so a half-saved entry is a logged warning rather
	// than an outage.
	go func() {
		err := watch.Watch(ctx, s.Dir, watch.DefaultQuiet, func() {
			if err := srv.RebuildAndNotify(); err != nil {
				log.Printf("rebuild failed, serving the previous index: %v", err)
			}
		})
		if err != nil {
			log.Printf("watcher stopped, the index will no longer follow the files: %v", err)
		}
	}()

	httpSrv := &http.Server{
		Handler: srv,
		// A connection that opens and never sends headers would otherwise hold a
		// goroutine for as long as the process runs. Cheap to bound, and the only
		// unbounded resource left once streams release on shutdown.
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: it applies to the whole response, and an SSE response
		// is deliberately open for hours. Bounding that would disconnect every
		// idle reader on a timer.
		IdleTimeout: 2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- httpSrv.Serve(ln) }()
	// After Shutdown has returned: a commit still running keeps its folder.
	defer srv.RemoveShadow()

	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		// Streams first: Shutdown waits for handlers to return, and an SSE
		// handler is still running by design. Without ending them it waits out
		// the whole timeout every time.
		srv.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}
