---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch` no longer trust `--serve-ready` when their own `--serve` died: a serve that exits before ready (a stale server held its port and answered the check) fails the run with `serve exited (N) before ready` and the serve log tail, a serve that exits mid-run kills the jobs and fails the run with `serve exited (N) during the run`, and a `--serve-ready` that already answers before serve starts warns `something is already listening on PORT`.
