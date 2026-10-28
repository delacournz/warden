---
"@delacour/warden": minor
---

- Every command run with `--json` now prints one JSON document on stdout when it fails, too: `{"ok":false,"command":"<command>","error":{"code":"usage"|"failed","message":"…"}}`. `usage` is an unknown option or a missing argument, `failed` the rest; the exit code and the red line on stderr are unchanged. Commands that already print their own failure document (`warden ui`, `warden perf`, `warden release`) keep it.
- `warden dev logs --json` failures add `"ok": false` and `"command": "dev logs"` beside `error`.
