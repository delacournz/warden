# WDN-TUI — `warden dev` as an interactive TUI

Plan ID: **WDN-TUI**. Phases **TUI-0 … TUI-7**. Repo: `delacournz/warden`, worktree `~/orca/workspaces/warden/murre`, branch `feature/murre` (off `develop`). Stacks on the three `warden dev` commits already there (show the sim, shut it down on exit, close its window).

## Context

`warden dev` today: claims a device + Metro port, installs the dev build, spawns `expo start --dev-client` with `stdin/stdout/stderr: "inherit"`, opens the dev client, then holds the leases until Metro exits. Warden's own progress (ora spinner on stderr, `note`/`warn` lines) and Expo's interactive output share one terminal and fight: the spinner line `preparing the ios dev build…` is drawn over Expo's QR code and menu. Expo's key menu (`a`, `i`, `r`, `m`, `j`, `o`, `?`, `shift+m`) reaches Metro because stdin is inherited, but nothing of warden's is visible once Metro takes over, and nothing warden does is interactive.

Goal (user, 2026-10-26): a TUI in the spirit of Turborepo's: task list left, the selected task's live output right, Metro's own menu usable inside its pane (keys pass through), warden's log visible live, warden's own actions and `warden perf` on keys, and a game-style perf HUD in the top-right corner.

## Decisions (user, 2026-10-26)

- Renderer: **hand-rolled ANSI renderer** in `apps/cli/src/dev-tui/` (no React, no native code). `@opentui/core` was the first pick and was researched (below), then dropped: it needs ESM bytecode and the user chose to keep the CLI's CommonJS bytecode build. `ink` fails the same way (`await import('./devtools.js')` at top level). Verified 2026-10-26 in a scratch compile.
- Metro pane: **full VT emulation** with `@xterm/headless` 6.0.0 + `@xterm/addon-serialize` (pure JS; compiles under `--compile --minify --bytecode`; +0.7 MB on a 67.6 MB binary; verified: `\e[2J\e[H` + SGR colours round-trip through `serialize()`).
- Keys: **two modes, Turborepo-style**: list mode = warden's lowercase keys; `Enter`/`i` on the Metro row = interact mode, every key to Expo until `Esc`.
- **On by default** on an interactive terminal; `--no-tui` / `WARDEN_TUI=0` opt out. `--json`, pipes, CI and agents keep today's plain output.
- Full key set + perf keys + **HUD top-right** (below).
- **Two PRs**: the three dev commits already on `feature/murre` ship now as PR 1; the TUI is PR 2 on top.
- Session logs on disk: **yes** (TUI-6).

## Facts that shape the design

### Bun
- Bun 1.4.3 has a native PTY: `Bun.spawn(cmd, { terminal: { cols, rows, data(term, chunk) } })` gives the child a real tty; `proc.terminal` has `write`, `resize`, `setRawMode`, `ref/unref`, `close`. Verified on this machine. Expo shows its menu only on a tty, so Metro runs in one of these.
- Tests can drive the TUI the same way: spawn `warden dev` under `Bun.Terminal` and assert frames.
- The CLI ships as `bun build --compile --minify --bytecode` = **CommonJS bytecode, no top-level await anywhere in the import graph** (`apps/cli/CLAUDE.md`, enforced by `source-build.test.ts`). This rules out `@opentui/core` and `ink` (both TLA). Stays as is.

### Why not opentui / ink (research 2026-10-26, kept for the record)
- `@opentui/core` 0.7.0: native Zig renderer + Ghostty VT (`EmbeddedTerminalRenderable`) over `bun:ffi`; the platform dylib embeds automatically in a compiled binary; but the package has top-level `await`, so `--bytecode` (CJS) fails to build (`Expected "=>" but found ";"`); only `--format=esm --bytecode` or no bytecode work (+10–14 MB). Rejected to keep the build.
- `ink` 6.8.0: `await import('./devtools.js')` / `await loadPackageJson()` at top level → same build failure under CJS bytecode. Works under `bun run`. Rejected.
- `@xterm/headless` 6.0.0 + `@xterm/addon-serialize`: builds and runs under CJS bytecode. Chosen for the Metro pane.

### `warden perf` surface (for keys + HUD)
- Live sampler (`apps/cli/src/perf/metrics-sampler.ts`, `metrics-watch.ts`): per app process, CPU % (delta of cumulative CPU over wall time; first reading has none) and RSS (iOS, host `ps` on the sim's app pid) / PSS+RSS (Android). Min interval 200 ms, default 1 s.
- fps + jank %: **Android only** (`dumpsys gfxinfo framestats`, `frames.ts` `androidFrameRate`). The iOS simulator has no frame API. The HUD must not fake an FPS there.
- Sessions: `perf start [--js --react --native --metrics --frames --logs --all] [--relaunch|--reset] [--max-duration]` (cap default 30 s, max 5 m), `perf stop`, `perf mark`, `perf report`, one-shots `metrics|memory|frames|startup|js|heap|react|native|logs|crashes`, `perf ls`, `perf doctor`. One session per device (`session_active`); sessions live at `$WARDEN_HOME/perf/<id>/`.

### Today's CLI UI
- `ctx.ui` (`ui.ts`: `rich`, `interactive`, `spinner`, `confirm/select`), `output.ts` (`heading`, `note`, `warn`, `reportError`, `success`), `withSpinner` routes a step's `ctx.err` lines above the ora spinner. Everything goes through `CommandContext.err/out`, so the TUI captures it without touching command bodies.
- `warden e2e` shares `launchMetro` (`metro.ts`) and must keep its pipe-based spawn.

## Architecture

```
apps/cli/src/dev-tui/
  model.ts          pure state: tasks[] {id, title, status, startedAt, endedAt, log: Line[]}, selected, mode (list|interact|help|prompt), hud {visible, sample, bundle}, perf {sessionId?, marks}
  reducer.ts        pure (state, event) → state. Events: task:start/ok/fail/idle, log, key, resize, metro:data, metro:exit, hud:sample, perf:*
  keys.ts           key → action map per mode (table below); the list of keys the help overlay renders
  render.ts         pure: state + size → frame (array of rows, ANSI); header, task list, log pane, Metro pane, HUD (top-right overlay), help overlay, mark prompt; diffed per row against the last frame
  screen.ts         terminal I/O: alt screen (`\e[?1049h`), cursor hide/show, raw stdin, SIGWINCH, synchronized updates (`\e[?2026h/l`), restore on exit/throw/signal (registered first)
  metro-pane.ts     PTY ↔ @xterm/headless glue (data → term.write, resize, serialize visible rows + cursor), Metro bundle-time parser ("iOS Bundled 1234ms")
  hud.ts            1 s ticker over the perf metrics sampler for the dev client app; formats CPU/mem/fps/jank/bundle/uptime
  actions.ts        warden actions behind keys (show sim, reopen client, screenshot, reinstall, restart sim, logs, Metro --clear restart, perf start/stop/mark/report/frames); each runs as a task row
  tui.ts            runtime: wires screen + reducer + render + metro-pane + hud + actions; exposes a `CommandContext` whose err/out append to the current task
  *.test.ts         colocated; frame tests under Bun.Terminal at 80×24 and 120×40
```

- `DevUi` seam in `dev.ts`: `plain` (today's code: spinner + inherit) or `tui`. `tui` when `ctx.ui.interactive && ctx.ui.rich && !opts.json && opts.tui !== false && env.WARDEN_TUI !== "0"`.
- Tasks: `claim` (device + port), `show` (sim window), `app` (install: source + hash), `metro`, `client` (dev client opened), `session` (holding: device, port, URL, hints). Action keys add transient rows (`screenshot`, `reinstall`, `restart sim`, `device logs`, `perf <id>`), which stay in the list with their log until quit.
- Metro pane: PTY and xterm sized to the pane (cols − list width − borders × rows − header − footer); resize follows the terminal (PTY `resize` + `term.resize`). xterm's buffer is the scrollback (`scrollback: 5000`).
- Two modes, Turborepo-style. **List mode** (default): warden's keys below apply. **Interact mode** (`Enter`/`i` on the Metro row): the Metro pane is focused and *every* key goes to Expo, including Ctrl-C (Expo exits → session ends the normal way) until `Esc` (`Esc Esc` sends a literal Esc). So Expo's menu keeps its exact bindings and warden's never collide.
- Ctrl-C in list mode = quit (today's path: stop Metro, shut the sim down, close its window, release). `q` is the same.
- Nothing in `packages/core` changes. `warden run`/`e2e` untouched.

## Key map (list mode)

| Key | Action | Reuses |
|---|---|---|
| `↑`/`↓`, `j`/`k` | select task row | |
| `Enter`, `i` | interact with Metro (every key to Expo; `Esc` returns) | PTY `write` |
| `Tab` | focus log pane (scroll with `↑↓`/`PgUp`/`PgDn`, `g`/`G` top/bottom), `Tab` back | |
| `r` | reload the app (sends `r` to Metro) | PTY |
| `d` | show the sim (bring its window to the front) | `revealSimWindow` |
| `o` | open the dev client again | `openDevClient` |
| `s` | screenshot → `$WARDEN_HOME/dev/<leaseId>/shots/<n>.png`, path in the row's log | `warden ui screenshot` path |
| `R` | reinstall the app (`installMode: "reinstall"`, Metro kept), then reopen the client | `ensureApp` |
| `x` | restart the sim (shutdown → boot → show → reopen client) | provider + `openDevClient` |
| `c` | restart Metro with `--clear` (same port) | `launchMetro` |
| `l` | device logs as a task row (stream, redacted); `l` again stops | `warden perf logs` / `warden ui logs` |
| `p` | perf session start/stop: `perf start --metrics --logs` (+`--frames` on Android) on the dev client app; `p` again = `perf stop`, report path in the row | `startPerf` / `finalizeSession` |
| `P` | perf start with `--all --relaunch` (startup + JS + React + native + metrics + logs) | `startPerf` |
| `m` | perf mark (prompts for a label; needs a running session) | `perf mark` |
| `f` | one-shot frames (Android; iOS: shows why not) | `warden perf frames` |
| `g` | perf report of the latest session, rendered in a task row (markdown summary + path) | `perf report` |
| `h` | toggle the HUD | |
| `?` | help overlay (warden keys + Expo's keys side by side) | |
| `q`, `Ctrl-C` | quit: stop Metro, shut the sim down, close its window, release | existing release path |
| `Ctrl-L` | redraw | |

Interact mode: everything to Expo (`a i w s j r m shift+m o ? Ctrl-C …`), `Esc` back, `Esc Esc` literal Esc, `Shift+PgUp/PgDn` scrolls xterm's buffer.

## HUD (top-right, absolute box, 1 s ticker)

```
┌ warden-iphone-17-5 ── 00:12:41 ┐
│ cpu  14% ▁▂▃▂▁▁▂   rss 182 MB  │
│ fps  —  (iOS sim: no frame API)│   ← Android: `fps 59  jank 2%`
│ metro bundled 1.3 s · 412 mods │
│ perf ● rec 00:00:19  marks 2   │   ← only while a session runs
└────────────────────────────────┘
```
- Source: the perf metrics sampler on the dev client's process (`MetricsTarget { udid, platform, app: bundleId }`), 1 s (`--hud-interval`, min 200 ms). CPU sparkline over the last 30 samples. iOS: RSS; Android: PSS + fps/jank. Bundle time and module count parsed from Metro's output lines. Session clock from the lease's `acquiredAt`.
- Off with `h`, `--no-hud`, or hidden when the terminal is narrower than 100 columns; shows `app not running` when the sampler finds no process. Sampling is host `ps` (iOS) / `top` + `dumpsys` (Android); cost measured in TUI-0 and shown as `hud 0.3%` if it is not negligible.
- Honest about iOS: no fps. Optional later: JS event-loop lag via the dev client's devtools as a proxy (out of this plan).

## Phases

### TUI-0 — 🔍 spike: Expo in a Bun PTY + xterm pane + harness (½ day)
1. **Expo in a PTY**: `Bun.spawn(["bunx","expo","start","--dev-client","--port",P], { terminal })` from `apps/example`. Confirm the menu renders, `r`/`?`/`m` written via `terminal.write` are handled, `resize` redraws, Ctrl-C (`\x03`) exits cleanly; note what Expo needs to stay interactive (`CI` unset, `EXPO_NO_TELEMETRY`?). Record a 10 s transcript (raw bytes) as a test fixture.
2. **xterm pane**: feed that transcript into `@xterm/headless` at 60×20, serialise, draw it inside a hand-drawn box in the real terminal; check colours, the QR block characters, cursor position, and that a `term.resize` + Expo's SIGWINCH redraw stays clean.
3. **Harness**: drive a spike binary (compiled with `compileArgs`) under `Bun.Terminal` 80×24 from a test, capture frames, strip our own `?1049`/`?2026` sequences. Becomes `dev-tui/harness.testing.ts`.
4. **HUD cost**: metrics sampler at 1 s against the dev client for 60 s; warden's host CPU.
5. Write **TUI-0 results** at the bottom of this plan. Gate for everything below.

### TUI-1 — 📦 `@xterm/headless` dependency + build guard
- `bun add @xterm/headless @xterm/addon-serialize` in `apps/cli` (pure JS; `source-build.test.ts` keeps proving the bundle has no top-level await).
- `startup.test.ts`: `dev-tui/*` and xterm are imported lazily (`await import("../dev-tui/tui")`) only in TUI mode, so `version`/`claim`/`heartbeat`/`gc`/`release`/`ui` load none of it. Measure `dist/warden` size delta (expected ≈ +0.7 MB).

### TUI-2 — ♻️ Metro in a PTY + `DevUi` seam
- `metro.ts`: `MetroProc` gains optional `terminal: { write, resize }`; `launchMetro`'s `spawn` may return it. `e2e` unchanged.
- `dev.ts` `defaultDevDeps.spawn`: third mode `{ kind: "pty", cols, rows, onData }`. Extract today's output into `DevUi.plain`; `dev()` picks `plain`/`tui`.
- Tests: plain unchanged; PTY mode passes size and forwards writes.

### TUI-3 — ✨ dashboard shell
- `dev-tui/{model,reducer,keys,render,screen,tui}.ts`: header, task list, log pane, footer hints, help overlay, `q`/Ctrl-C quit, list/log focus; per-row diff rendering, synchronized updates, restore on exit/throw/signal. `ctx.err`/`note`/`warn`/`reportError` → current task's log; `withSpinner` text → running label.
- `--no-tui`, `WARDEN_TUI=0`; help snapshot.
- Reducer/keys pure tests; frame tests through the harness.

### TUI-4 — ✨ Metro pane with key passthrough
- `metro-pane.ts`: `@xterm/headless` ↔ PTY; interact mode (raw key bytes → `terminal.write`); resize; bundle-time parser; cursor placed at xterm's cursor when focused.
- Tests: recorded Expo transcript from TUI-0 → frame snapshot; key bytes reach `terminal.write`.

### TUI-5 — ✨ warden actions + perf keys
- `actions.ts`: `d o s R x c l` and `p P m f g` as in the key map, each as a task row with its own log; `m` uses a one-line prompt in the footer; perf rows show session id, captures, cap countdown, and the report path on stop.
- Guard rails: one perf session per device (`session_active` → explain), `x`/`R` disabled while a perf session records, `c` restarts Metro on the same leased port.

### TUI-6 — 📊 HUD + session log on disk
- `hud.ts` as specified; `h`, `--no-hud`, `--hud-interval`.
- `$WARDEN_HOME/dev/<leaseId>/{warden.log, metro.log, shots/}`: every task line and the raw Metro stream, so a crash or closed terminal leaves evidence; `warden gc` removes dirs whose lease is gone (> 1 day).

### TUI-7 — 📝 docs, skill, changeset
- `apps/docs/content/docs/agents/dev.mdx`: "The dev TUI" section (frame screenshot, key table, HUD, `--no-tui`/`WARDEN_TUI=0`/`--no-hud`, agents always get plain via `--json`). `reference/cli.mdx`, `reference/environment.mdx` rows. `devices/perf.mdx`: "from the dev TUI" paragraph.
- `skills/warden/`: agents keep `warden dev --json`.
- One **minor** changeset (new flags, env vars, behaviour; ESM bytecode build noted as internal).
- `bun run signoff`.

## Where to do it
Worktree `murre`. PR 1 = `feature/murre` as is (three dev commits). PR 2 = branch `feature/wdn-tui` off `feature/murre` (rebased onto `develop` once PR 1 merges).

## Agents / waves
- Wave 1: TUI-0 (one agent; results into this file).
- Wave 2: TUI-1 (dep) then TUI-2 and TUI-3 in parallel (distinct files).
- Wave 3: TUI-4, TUI-6 (log on disk half) in parallel.
- Wave 4: TUI-5, TUI-6 (HUD), then TUI-7.
Each agent: TDD, `bun test <path>`, biome, typecheck, commit per phase with gitmoji, no attribution trailers.

## Verification
- `bun test apps/cli` green; frame snapshots 80×24 and 120×40 via the harness.
- Manual on this Mac in `apps/example`: TUI appears, tasks tick, Expo menu in its pane with colours + QR, `r` reloads, `i` + `?` shows Expo's help inside the pane, `Esc` back, `d`/`o`/`s`/`R`/`x`/`c`/`l` work, `p` records and `g` renders the report, HUD updates every second, `q` shuts the sim down and closes its window, terminal restored. `warden dev --json | cat` and `WARDEN_TUI=0 warden dev` behave like today.
- Compiled binary: `bun run --cwd apps/cli build`, run `dist/warden dev` once; `warden version` cold start unchanged (nothing new loads outside TUI mode).

## Unresolved questions
None open. Q1 (build) answered "reconsider renderer" → hand-rolled + xterm, CJS bytecode kept. Q2 two modes, Q3 two PRs, Q4 logs on disk: all yes (2026-10-26).

## TUI-0 results

Run 2026-10-26 on this Mac (Bun 1.4.3, Expo CLI 57.0.27, `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0). Spike code: `apps/cli/spikes/tui/`. Fixture: `apps/cli/src/dev-tui/fixtures/expo-start.bin` (+ README).

- **1. Expo in a PTY: works.** Menu, QR and colours render. Startup: first output at ~0.2 s, QR at ~1.2 s, `Press ? │ show all commands` hint at ~1.2 s.
  - Expo prints only the hint line at start; `?` prints the full menu (699 bytes). Pressing `?` again prints it again, it does not collapse.
  - `r` ("Reloading apps"), `m` ("Toggling dev menu") and `?` are handled through `terminal.write`. With no app connected, `r`/`m` also print a yellow "No apps connected" warning.
  - `shift+m` opens an interactive prompt (prompts hide the cursor, `\e[?25l`). `\x03` while a prompt is open cancels only the prompt (`\e[2K\e[1A` x6, red "✖", cursor shown); a second `\x03` exits. The TUI must not treat Ctrl-C in interact mode as "Expo is gone"; only the PTY `exited` promise says that.
  - `\x03` at the menu: spinner "Stopping server", then "Stopped server", exit code 0 in ~0.2 s.
  - **`terminal.resize` makes Expo print nothing.** No redraw on SIGWINCH; the old menu stays as it was. A resize needs no special handling beyond `term.resize`, and the pane keeps its old lines (xterm reflows them).
  - **Env:** `CI` must be unset. With `CI=1` Expo drops the QR and the key menu ("Metro is running in CI mode, reloads are disabled") and keys are only echoed; the PTY child must get `CI` removed, `warden dev` should delete it for Metro. `EXPO_NO_TELEMETRY` and `TERM` made no visible difference (`TERM=dumb` still draws the menu, only without colour); set `TERM=xterm-256color` explicitly, a TUI host may run under another TERM. Chosen env for the Metro PTY: parent env minus `CI`, `TERM=xterm-256color`, `EXPO_NO_TELEMETRY=1` kept as today.
  - **PTY chunks split multi-byte UTF-8** (a 1024-byte chunk ended inside a half-block character). Pass raw `Uint8Array` chunks to `term.write`; never `decode()` per chunk.
- **2. xterm pane: works, with one caveat on the serialize addon.**
  - Options that worked: `new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })`; write via `term.write(data, cb)` (async, resolve on the callback).
  - The pane is drawn per row at an offset: `CSI r;c H`, `│`, `CSI 0m`, `CSI <w> X` (erase, keeps the box clean), the row, `CSI 0m`, `CSI r;c+w+1 H`, `│`, whole frame wrapped in `?2026h/l`. Cursor is placed at `ox+1+cursorX, oy+1+cursorY` when focused (`cursorX/Y` are viewport-relative, `buffer.active.baseY` is the scrollback length). Tested: 60x20, 60x50 (QR in view, columns line up, 35-wide), and `term.resize(70,24 | 70,50)` + more output + full repaint.
  - Cell-by-cell comparison of the real terminal against the xterm buffer (char, fg/bg mode+colour, bold, dim, underline, italic): **0 mismatches with our own row serialiser; 0 cells leaked outside the box; borders intact; cursor exactly where expected** (all four runs).
  - **Caveat: `SerializeAddon.serialize({ range })` drops DIM when BOLD turns off** (`\e[2m…\e[1m…\e[22m` loses the dim for the rest of the row; 11 cells wrong on the Expo menu, e.g. the `│ open web` part). Cause: it emits SGR 22 (clears both). Decision for TUI-4: **drop the addon, hand-roll `serializeRow(line, cols)` from `IBufferCell` attributes** (`spikes/tui/xterm-pane.ts`, ~40 lines; 16-colour mode must emit 30-37/90-97 not `38;5;n`; trailing blanks trimmed). Removes `@xterm/addon-serialize` from TUI-1's dependency list; only `@xterm/headless` is needed. The addon still works for whole-buffer dumps in tests but is not needed.
  - Cost: `write` of the whole 3.9 KB transcript 1.3 ms; of 389 KB (100x) 12-15 ms. Serialising one 60x20 viewport with the own serialiser: 0.15 ms cold, 0.09 ms warm (addon: 0.24 / 0.04 ms). The pane is far below any render budget; 5000 lines of scrollback add nothing to a frame.
- **3. Harness: works, no stripping needed.** `harness.ts` spawns the binary compiled with `bun build --compile --minify --bytecode` (35-line `spike-bin.ts`, 129 ms to compile, no TLA) under `Bun.spawn(..., { terminal: { cols: 80, rows: 24, data } })`, feeds every chunk to a second `@xterm/headless` (`scrollback: 0`), and reads rows with `buffer.active.getLine(baseY + y).translateToString(true)`.
  - Tolerated by xterm headless as-is: `?1049h/l`, `?25l/h`, `?2026h/l`, `CSI 2J`, SGR incl. truecolor and 256-colour, `CSI r;c H`. Nothing to strip. Do not strip `?1049`: xterm switches to the alternate buffer and `buffer.active.type` is `alternate` while the app runs.
  - **A frame must be read before the process exits**: on `?1049l` xterm returns to the normal buffer, which is blank, so the final frame is gone. Harness API to build: `waitFor(predicate)` on the current frame, then send keys, then assert exit code and restore sequences (`?25h`, `?1049l`).
  - Writes are async: serialise reads behind a promise chain of `term.write` callbacks (done in `harness.ts`).
  - `resize(cols, rows)` = `proc.terminal.resize` + `term.resize`; the child saw SIGWINCH and `process.stdout.columns/rows` updated (100x30 verified).
  - Keys: `proc.terminal.write("q")` reached raw-mode stdin; exit code 0 and `?25h` + `?1049l` emitted.
- **4. HUD cost: the plan's sampler is too expensive at 1 s; fix before TUI-6.** Device: leased `warden-iphone-17-5`, cached dev build installed with `warden app ensure ios --udid` (fingerprint cache hit), app launched, `warden perf metrics --watch --interval 1s --duration 60s --json` with the compiled binary; released with `warden release <id> --shutdown`.

  | Interval | warden CPU incl. children, 60 s | share of one core | warden process alone (RSS) |
  |---|---|---|---|
  | 1 s | 9.7 s (4.1 user + 5.8 sys) | ~16% | 0.45 s CPU = 0.7%, 54 MB |
  | 200 ms | 28.5 s | ~47% | not measured |

  - Breakdown per sample (measured on the 1512-process host): `xcrun simctl spawn <udid> launchctl list` (pid lookup, `appPid`) ~95 ms CPU; host `ps -axo pid,ppid,rss,%cpu,time,lstart,command` ~53 ms CPU; a pid-only `ps -o pid,rss,time -p <pid>` ~2 ms.
  - **Change for TUI-6:** the sampler resolves the pid once (the `launchctl` path), then reads `ps -p <pid>` only, re-resolving when that pid is gone or its start time changes. Expected ~2 ms/sample ≈ 0.2-0.4% of a core at 1 s. That change belongs in `metrics-sampler.ts` (`perf metrics` benefits too), with a test for "pid cached, re-resolved on exit". Until then do not ship an always-on 1 s HUD; with the fix show no `hud x%` label by default.
  - Android was not measured (no emulator in this spike); it uses `adb shell top -n 1 -p` + `dumpsys meminfo` per sample, expect a higher cost, measure in TUI-6.
- **Surprises that change later phases**
  - TUI-1: only `@xterm/headless` is needed; drop `@xterm/addon-serialize` (dim bug; own serialiser is simpler and faster).
  - TUI-2/4: remove `CI` from the Metro PTY env; keep raw `Uint8Array` chunks; `exited` (not Ctrl-C) decides that Metro is gone, since Ctrl-C can only cancel an Expo prompt.
  - TUI-3 harness: capture frames while the app runs, never after exit.
  - TUI-4: Expo does not repaint on resize; the pane is a log, not a screen. Plan the cursor: Expo's cursor sits on the row after the last output, usually blank.
  - TUI-6: fix the sampler's per-sample cost first (above); HUD interval stays 1 s.
- **Go / no-go: GO** for TUI-1..7 with the changes above (own row serialiser, pid-cached sampler, `CI` removed). No blocker found.
