---
type: note
title: Every kind
tags: [demo]
status: todo
---

# Every kind

A paragraph with **bold**, *italic*, `code`, ~~strike~~ and a [link](./editor-adr.md), a [missing](./nope.md) one, an [outside](../../x.md) one, an [external](https://example.com "Example") one and a [bad](javascript:alert(1)) one.

## A table

| Area | Q1 | Notes |
| --- | ---: | --- |
| Reader | 12 | up |
| Boards | 4 | down |

## Code

```go
func main() { fmt.Println("hi") }
```

> [!warning] Careful
> A callout with a to-do:
> - [ ] inside

> A plain quote.

- [ ] open item
- [x] done item
  - nested bullet
1. first
2. second

---

![Local](./missing.png) and a remote ![Team photo](https://images.example.com/team.png).

<div>raw html stays text</div>

A paragraph with a [reference link][docs], a [collapsed one][], and a [shortcut].

[docs]: https://example.com/docs
[collapsed one]: ./index.md
[shortcut]: https://example.com/short
