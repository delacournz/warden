---
"@delacour/warden": minor
---

- Anonymous usage telemetry, on by default. One `command` event per run: the command (`ui press`, `e2e`), the names (never the values) of the flags you typed, `--json`, `ios` or `android`, how many suites `e2e` was asked for, how it ended, how long it took, the exit code and the class name of an error. Never source, paths, suite or test names, bundle ids, UDIDs, URLs or error messages. The first run prints a notice to stderr (held back under `--quiet`); stdout and `--json` are never touched. `hook`, `heartbeat`, `version`, completion and background workers send nothing; `dev` and `mcp` report when they start.
- `warden telemetry [status|enable|disable] [--json]` shows or switches it. `WARDEN_TELEMETRY_DISABLED=1`, `DELACOUR_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` turn it off and win over `enable`; `DELACOUR_TELEMETRY_DEBUG=1` prints the request to stderr instead of sending it. Dev and local builds never report. What is sent: [CLI reference](https://warden.co.nz/docs/reference/cli#telemetry).
