---
"@delacour/warden": minor
---

- `warden host run <name> -- <command…>` (short: `warden --host <name> <command…>`) runs `perf`, `golden ls` / `golden ensure`, `builds ls`, `capacity` or `queue` with a host's warden, its output and exit code passed back. Perf acts only on your own device there: a local host lease id after `--lease` is translated, and with one device on that host none is needed.
- `warden host fetch <name> perf <session id> [--out <dir>]` copies a perf session from the host into this machine's perf directory, so `warden perf report` / `query` / `diff` read it here.
