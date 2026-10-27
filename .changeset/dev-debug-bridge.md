---
"@delacour/warden": minor
---

- `warden dev` holds one devtools connection to the app for the whole session (the dashboard's `devtools` row). It captures console lines, uncaught exceptions and `fetch` calls from launch, and `warden ui` devtools verbs read from it instead of opening their own connection. Without a dev session they connect directly as before.
- `warden dev logs` reads Metro's output, classified as `bundle_start`, `bundle_done`, `bundle_failed`, `hmr`, `error`, `warn` and `info`, with file, line and code frame for bundle and transform errors. It takes `--since`, `--tail`, `--grep`, `--kind`, `--follow` and `--json`.
- New `warden ui exceptions`, `warden ui route` and `warden ui devtools status|resume`. `warden ui logs` and `warden ui network` gain `--since`, `--level`, `--grep`, `--status` and `--limit`.
- Exception and console stacks are symbolicated through Metro to source file and line, with Metro's code frame. Errors React Native reports through its exception handler count as exceptions.
- `warden ui logpoint add <file:line[:col]> '<expression>'` logs a value every time a source line runs, without pausing the app or editing code. `--hits <n>` removes it after n hits. It comes with `logpoint list|rm|clear|hits`. Logpoints are set again after a reload and end with the session. They need the Fusebox debugger.
- `warden perf js` records through the dev session's connection when `warden dev` runs. Other perf captures hand the connection back when they finish.
- `warden perf js` hotspots now map to source on React Native apps, which load their bundle as `index.bundle//&…`.
- When Chrome DevTools takes the app on a Metro that allows one debugger, the session's connection waits instead of taking it back. `warden ui devtools resume` reattaches.
- `warden mcp` is an MCP server on stdio. Its tools are `dev_sessions`, `metro_logs`, `app_console`, `app_exceptions`, `app_network`, `app_eval`, `app_tree`, `app_route`, `app_reload`, `logpoint_add|hits|list|remove`, `profile_start|stop|status` and `devtools_status|resume`.
