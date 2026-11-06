---
"@delacour/warden": minor
---

- `@delacour/warden-e2e` exports `run(command, options?)`: runs a shell string (`sh -c`) or an argv on the host from a spec and resolves `{ ok, exitCode, stdout, stderr, ms, json() }`, so a spec can seed a backend or call a script without importing from `bun`. Options `cwd`, `env`, `input`, `timeout` (default `60s`, then `TIMEOUT`) and `check` (default true).
- New `E2eError` code `RUN_FAILED`: a `run` command exited non-zero or could not start.
