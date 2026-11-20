---
type: task
title: "remove the [tool.wikiview] migration"
status: todo
priority: low
tags: [debt, config]
---

v0.19.0 moved boards and graphs to the standard's `[[board]]` and `[[graph]]`. `config.Migrate` renames an older wiki's `[[tool.wikiview.board]]` and `[[tool.wikiview.graph]]` tables when WikiShell opens it, and `leftBehind` reports what it could not move. Both exist only to carry old wikis across.

**When:** the first release on or after 2027-01-01 (the CEO's call, in the boards-standard ADR). Foreman removes its copy at the same time.

**What goes:** `internal/config/migrate.go` and its tests, `Server.MigrateConfig` and its two callers, and the "From an older wiki" paragraph in the README.

**Known limit until then:** the rewrite works line by line and does not parse TOML. A line inside a multi-line string that looks like an old header (`[[tool.wikiview.board]]` at the start of a line) is renamed too. Accepted in review (Audy's L-1): such a line in a `wiki.toml` is very unlikely, and parsing is what would lose the user's comments and formatting.
