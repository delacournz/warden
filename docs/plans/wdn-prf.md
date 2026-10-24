# Plan WDN-PRF — `warden perf`: profiling for RN/Expo + native iOS/Android

## Context

Warden can't profile mobile apps today; there's no profiling code anywhere in the repo. Agents are still reaching for argent or agent-device to do it, and both of those are retired.

The goal is one command group, `warden perf`, that takes the best of both:
- **From argent (Apache-2.0):**
  - React commit profiling via the DevTools hook, plus a Hermes `Profiler.start`.
  - xctrace toc→xpath export with an id/ref streaming parser.
  - Perfetto with batched PerfettoSQL.
  - Hot-commit filter (16ms floor plus cbrt heat).
  - Wall-clock JS↔native alignment.
  - Drill-down query tools.
- **From agent-device (MIT):**
  - `gfxinfo framestats` frames with jank clusters.
  - `meminfo` PSS breakdown.
  - iOS `ps` sampling with exact executable matching.
  - Pid-scoped logs that restart when the pid changes.
  - simpleperf.
  - memgraph and hprof dumps.
  - Findings taxonomy for React (`slow-commit`, `memo-defeated`, `context-cascade`, …).
  - Artifact on disk, compact summary in the output.

**Things neither tool does, which warden adds:**
- A JS `.cpuprofile` that is **source-mapped**.
- Real startup time: `am start -W`, plus the xctrace App Launch template.
- CPU and memory **time series**.
- Crash collection.
- `perf diff` between two sessions, for regressions.
- Perf budgets inside e2e specs.

**Decisions (answered):**
- v1 covers simulators and emulators only. Physical devices come as a later wave (PHY-*), which is in this plan.
- Command name is `warden perf`. `--profile` keeps its existing meaning (device profile).
- Android SQL goes through a pinned `trace_processor_shell`. The download needs **confirmation** (interactive prompt or `--yes`) and shows a **progress bar**.
- Output is a capped markdown summary with `next:` hints, plus `--json` (UiJson envelope), plus raw artifacts on disk.
- argent is a **clean-room rewrite**: we study its approach as reference only and copy no code, scripts, SQL or template assets. agent-device code (MIT) may be adapted, with a notice.
- Perf budgets for e2e (PRF-11) ship **in this PR**.
- Live `perf metrics --watch` sparklines ship in PRF-2.
- Sessions stop automatically after **30s by default**, with a **5m hard max** (`--max-duration`).

## What we reuse (don't rebuild)

| Need | Existing code |
|---|---|
| Command define/register | `apps/cli/src/command.ts` `defineCommand`; `apps/cli/src/commands/registry.ts` (lazy `load`) |
| Device resolution/lease | `apps/cli/src/agent-ui/device.ts` `resolveUiDevice`; `device-lease.ts` `ensureCallerLease`; `agent-ui/ui-options.ts` `withUiOptions` |
| Run frame + JSON envelope | `agent-ui/run.ts` `runUi`; `agent-ui/output.ts` `UiJson`, `UI_ERROR_EXIT`; `apps/cli/src/output.ts` `emit`/`reportError` |
| Detached start/stop + pid safety | `agent-ui/video.ts` `uiVideo`; `agent-ui/process-identity.ts` `mayBeRecorded`/`safeToSignal`; `agent-ui/state.ts` `updateState` |
| Background collector pattern | `apps/cli/src/commands/ui-collect.ts` + `packages/e2e/src/devtools/collector.ts` |
| Metro / Hermes CDP | `packages/e2e/src/devtools/{metro,inspector,cdp,session}.ts` (`findMetro`, `listTargets`, `openCdp`, `connectDevtools` with `send`/`onCdp`) |
| React fiber access | `packages/e2e/src/devtools/tree.script.ts` (pattern for injected scripts) |
| ps / adb top parsing | `packages/e2e-bench/src/harness/sampler.ts` (`parsePs`, `PS_ARGS`, `parseAdbTop`, `cpuDeltas`, `withDescendants`), which moves into the new package |
| App pid | `packages/e2e/src/driver/android/android-argv.ts` `pidofArgv`; `driver/ios/simctl.ts:143` launchctl parse |
| Confirm prompt | `apps/cli/src/ui.ts` `ctx.ui.confirm`, `ctx.ui.interactive`; `--yes` pattern in `commands/install.ts` |
| Injected effects + tests | `apps/cli/src/context.ts`; `apps/cli/src/testing.ts` `testContext`, `fakeExec`; `simctl.testing.ts` `fakeSimctl` |

## Architecture

- **New package `packages/perf`** (`@delacour/warden-perf`, private, bundled into the binary). It holds only pure capture argv builders, parsers and analyzers; no CLI code.
  ```
  src/shared/   session.schema.ts, align.ts, findings.types.ts, render-md.ts, caps.ts
  src/metrics/  ps.ts (moved from e2e-bench), adb-top.ts, meminfo.ts, sampler.ts
  src/frames/   gfxinfo.ts (framestats + jank clusters), ios-hitches.ts
  src/startup/  android-am-start.ts, ios-app-launch.ts
  src/js/       cpu-profile.ts (CDP), symbolicate.ts (Metro sourcemap), heap.ts, hotspots.ts
  src/react/    profiler.script.ts, bootstrap.script.ts, pipeline/{hot-commits,reduce,tag,rank,cpu-correlate}.ts
  src/ios/      xctrace-argv.ts, export.ts, xml-parser.ts, analyze.ts, memgraph.ts
  src/android/  perfetto.config.ts (textproto), capture.ts, simpleperf.ts, trace-processor.ts, queries/*.sql, analyze.ts
  src/logs/     logcat.ts, ios-log-predicate.ts, pid-follow.ts, crashes.ts, symbolicate-ios.ts
  ```
  `packages/e2e-bench` then imports the samplers from this package.
- **CLI:** `apps/cli/src/commands/perf.ts` (group `Run`) plus `apps/cli/src/perf/*.ts`, one file per subcommand.
  - Hidden `warden perf-collect` is the detached sampler/logger, same pattern as `ui-collect`.
- **Session = directory.** Path is `$WARDEN_HOME/perf/<id>/`; `id` = `<yyyymmdd-hhmmss>-<hash6>`.
  ```
  session.json        zod: {id, device, app, startedAt{wallMs, deviceWallMs}, capturers[{kind, pid, startedAtIso, out, state}], marks[]}
  report.md report.json
  metrics/samples.jsonl  frames.json  startup.json
  js/cpu.cpuprofile  js/hotspots.json  js/heap-*.heapsnapshot
  react/commits.json  react/findings.json
  native/ios.trace | native/android.perfetto-trace | native/simpleperf.data | native/*.memgraph | *.hprof
  logs/device.log  crashes/*
  ```
  - The device's `ui/<udid>/state.json` gets `perf: {sessionId}`, which enforces one active session per device.
  - Stop always runs `safeToSignal` before sending a signal, so foreign processes are never touched.
- **Device targeting: works on any running warden device.** This is a new `resolvePerfDevice` in `apps/cli/src/perf/device.ts`, built on `resolveUiDevice` and `store.listDevices`.
  - Resolution order:
    1. `--udid/--serial/--lease`.
    2. `WARDEN_UDID`.
    3. The caller's own single lease.
    4. Otherwise, **any booted device in warden's store** (warden-created or warden-leased).
    5. If several match, fail with `ambiguous_device` and list them (udid, name, holder label, app in foreground). `perf ls --devices` shows the candidates.
  - Devices warden doesn't know about are refused with `device_unknown` (AGENTS.md: foreign = read-only; we only attach to warden's own).
  - **Observe-only capturers** run on a device leased by someone else or by nobody, and **never take or heartbeat the lease**:
    - metrics (ps/top/meminfo)
    - xctrace `--attach`
    - perfetto, simpleperf
    - Hermes/React profiling over Metro
    - logs, crashes
    - frames read (no `reset`)
  - The report records `target: {udid, holder?, ownedByCaller}`.
  - **Mutating ops need the caller's own lease** (`ensureCallerLease`; `--claim` works): `perf startup` (kill/launch), `--leaks` cold launch (MallocStackLogging), `memory --snapshot` (dumpheap/leaks pause the app), `heap snapshot` (stop-the-world GC), and gfxinfo `reset`. Without one they fail with `device_foreign` and the hint `--claim` or `--allow-mutate-foreign` (refused if the holder's lease is live and exclusive).
  - **Agent fix loop: reset the app, then profile.** `perf start|record` accept `--relaunch` and `--reset`.
    - `--relaunch` terminates the app, arms the capturers, then launches the app, so the trace covers the process from its first instruction. That gives startup plus early JS/React data.
      - iOS: `simctl terminate`, then `xctrace --launch -- <App.app>` (or `simctl launch` while attached).
      - Android: `am force-stop`, start perfetto, then `am start -W`.
      - Metro/Hermes profiling waits for the new target (`listTargets` poll, with `runIfWaitingForDebugger` handled by `connectDevtools`).
    - `--reset` also clears app state before launching.
      - Android: `pm clear <pkg>`.
      - iOS: `simctl uninstall` plus `simctl install` of the same `.app` from `simctl get_app_container` or the warden build cache.
      - Either way the app is reinstalled from the exact same build, never a different one.
    - Lease rule for these:
      - Unleased warden device: take a short `warden perf` lease (`claimWithFlags`, label `warden perf`), released on `stop`.
      - Device under the caller's own lease: fine.
      - Device under someone else's live lease: refused with `device_foreign`, plus a hint to use `--claim` on a free device. A live foreign session is never disrupted.
    - The skill's workflow documents the loop: `perf record` (spot the issue) → fix the code → Metro reload, or a rebuild via `warden dev` → `perf record --relaunch` → `perf diff <before> <after>`.
  - One active perf session per device, whoever owns it. A second `perf start` gets `session_active` plus the owner, and `--join` attaches read-only to the live session's marks/report.
- **Subcommands**, all taking `withUiOptions` flags plus `--app <bundleId|pkg>`. The app defaults to the foreground app, then to the warden.config app.
  - **Session**
    - `perf start [--js] [--react] [--native[=time|trace|simpleperf]] [--metrics] [--frames] [--logs] [--all]` and `perf stop [--no-analyze]`.
    - `perf record --duration 10s [same flags]` does start, sleep, stop in one call.
  - `perf mark "<label>"` adds a timeline annotation. Commits and hangs are tagged with the last preceding mark.
  - **One-shots**
    - `perf metrics [--interval 1s --duration 10s]`, `perf memory [--snapshot]`, `perf frames`.
    - `perf startup [--cold|--warm] [--runs 5]`.
    - `perf heap snapshot|diff`.
  - **Analysis**
    - `perf report [id]`, `perf ls`, `perf diff <a> <b>`.
    - `perf query <id> commits|cpu|stacks|frames [--by component|window|function] [...]`.
  - **Observability:** `perf logs [--follow --since]`, `perf crashes [--since] [--symbolicate --dsym]`.
  - **Setup:** `perf doctor`, `perf tools install trace-processor [--yes]`.
- **Output rules**
  - Every analysis writes `report.md` plus `report.json` (typed `Finding` discriminated union: `{kind, severity, costMs, evidence, fix, next}`).
  - Text mode prints at most about 40 lines, then `next:` commands.
  - `--json` returns the UiJson `result`.
  - Each failure carries `{code, message, hint}`, e.g. `not_profileable` plus a manifest snippet, `metro_not_found`, `tool_missing`.
  - Reports run in a simulator carry a **"simulator: compare relative, not absolute"** banner. Reports from dev builds carry a **`__DEV__`** warning.

## Team wdn-prf: waves of parallel subagents, one commit per phase, one PR to main

Each phase is tests first (fixtures from real command output under `packages/perf/fixtures/`), then implementation, then `bun test <path>`. Each one also updates `help.test.ts` snapshots (`bun test -u`), adds its `### warden perf …` section to `apps/docs/content/docs/reference/cli.mdx`, and touches the skill reference. No real simctl or adb calls in `bun test`; everything goes through injected `exec`/`spawn`.

### Wave 1 (blocking)

**PRF-1 — ✨ feat(perf): `warden perf` skeleton, session store, doctor**
- Scaffold `packages/perf` using the AGENTS.md "Adding a package" checklist.
- Move `parsePs`, `parseAdbTop`, `cpuDeltas` and `withDescendants` from e2e-bench into `packages/perf/src/metrics/ps.ts` and re-point the imports.
- `session.schema.ts` (zod), `createSession`, `readSession`, `updateSession` (atomic, `updateState` style), and `listSessions`.
- `commands/perf.ts` registered in `registry.ts` (group Run). Subcommands: `ls`, `mark`, `doctor`.
- `doctor` checks:
  - `xcrun xctrace version`, `adb version`, and `adb shell which perfetto simpleperf`.
  - Whether trace_processor is cached.
  - Metro reachable (`findMetro`), and the app is debuggable/profileable (`dumpsys package <pkg>` flags).
  - Xcode version, flagging the 26.4+ `--device` deadlock.
- App detection:
  - iOS: `launchctl list` → `UIKitApplication:<bundle>`.
  - Android: `dumpsys activity activities | mResumedActivity`.
- Shared `render-md.ts` with caps and `next:` hints, plus a `Finding` union.
- Session cap: `maxDurationMs` in `session.json`. The default is 30s, set with `--max-duration`, and anything over 5m is clamped with a warning. `perf-collect` owns an auto-stop timer; `perf start` sweeps stale sessions (dead pid) and stops any that went over their cap.
- `resolvePerfDevice` comes with tests: an unleased warden device, a device under a foreign lease (observe OK; mutate refused), an unknown device refused, and the ambiguous case listing candidates.
- Tests: session lifecycle, single active session per device, `safeToSignal` refusal, cap clamp and auto-stop (injected clock), registry/help drift, completion.

### Wave 2 (parallel after PRF-1)

**PRF-2 — ✨ feat(perf): metrics time series (cpu/mem)**
- iOS sim: `simctl spawn <udid> ps -axo pid,ppid,rss,%cpu,time,lstart,command`, matched on the full executable path (`simctl get_app_container` plus `plutil -extract CFBundleExecutable`). CPU % comes from the cputime delta, not the decaying `%cpu`.
- Android: `adb shell top -n 1 -b -p <pid>` for CPU, and `dumpsys meminfo <pkg>` for TOTAL PSS/RSS plus the top 5 categories.
- `perf metrics`: one-shot or interval series written to `metrics/samples.jsonl`. Summary is min/avg/p95/max plus memory growth slope (leak hint).
- `perf memory --snapshot`:
  - iOS: `simctl spawn leaks --outputGraph`, summarised with `leaks`/`vmmap --summary`.
  - Android: `am dumpheap` → `.hprof`, pull and rm; raw only, with a hint to open in Android Studio.
- In a session: `perf-collect` samples at 1s intervals.
- `perf metrics --watch`:
  - Redraws CPU %, RSS/PSS and fps (Android, through gfxinfo deltas) as unicode sparklines with current/avg/max, on stderr only, about every 1s, using `ctx.ui.rich`.
  - Non-TTY or `--json` falls back to one NDJSON line per sample on stdout.
  - Ctrl-C prints the summary and exits 130.
  - The sparkline renderer is a pure function (`render-spark.ts`) and is snapshot-tested.

**PRF-3 — ✨ feat(perf): frames / jank**
- Android: `dumpsys gfxinfo <pkg> framestats`, then `reset`. Parse the `Janky frames` summary and the PROFILEDATA CSV. Deadline is the median vsync delta (4–50ms); clusters split on gaps over 500ms; report the top 3 worst windows. Fixtures cover 60/90/120Hz.
- iOS sim: **spike first.** Try `xctrace record --template 'Animation Hitches'` against a sim. If unsupported, derive hitches from the Hangs instrument (PRF-7) and say so in the report.
- Output: fps, jank %, frozen frames (over 700ms), worst windows aligned to marks.

**PRF-4 — ✨ feat(perf): startup time**
- Android: `am start -W -S -n <component>` for cold, without `-S` after HOME for warm. Parse `TotalTime` and `WaitTime`. Run N times; report median and p90. A `reportFullyDrawn` hint covers TTI.
- iOS sim: `xctrace record --template 'App Launch' --launch -- <App.app>`. Export the `app-launch` / lifecycle schemas: process start, then first frame. **Spike on sim support**; the fallback is `simctl launch --terminate-running-process` plus a `warden-simd` first non-empty AX tree, with wall-clock time marked `method: approx`.
- RN layer (both platforms): read `performance.getEntriesByType('mark')` and RN startup marks through CDP when Metro is attached.

**PRF-5 — ✨ feat(perf): Hermes JS CPU profile + heap**
- `connectDevtools().send('Profiler.enable')`, then `Profiler.start` (`setSamplingInterval` 100µs), then `Profiler.stop` → `js/cpu.cpuprofile`, which opens in Chrome DevTools or speedscope.
- Record device `Date.now()` at start as the alignment anchor.
- **Source maps:**
  - Capture the `sourceMapURL` from `Debugger.scriptParsed`, fetch it from Metro (SSRF guard: Metro host only, 64MiB cap), and map each node's `callFrame` with `@jridgewell/trace-mapping` (lazy import).
  - Hotspots are the top self/total functions with `file:line`. Group `node_modules` frames by package.
- `perf heap snapshot`: `HeapProfiler.takeHeapSnapshot` streaming chunks → `.heapsnapshot`. Summary is the top constructors by retained size. `diff` compares two snapshots' constructor counts. **Spike Hermes coverage first.**

**PRF-10 — ✨ feat(perf): logs + crashes**
- Android: `adb logcat -v threadtime --pid <pid>`, with `pid-follow.ts` re-resolving `pidof` every 2s and restarting the stream on change. One-shot is `logcat -d -t N`.
- iOS sim: `simctl spawn <udid> log stream --style compact --level info --predicate <bundle/exe predicate>`, using agent-device's predicate.
- Logs are redacted (tokens, `Authorization`, emails) before they are written.
- `perf crashes`:
  - iOS: `~/Library/Logs/DiagnosticReports/*.ips` filtered by process name, `since`, and the sim udid inside the .ips.
  - Android: `logcat -b crash -d`, plus `dumpsys dropbox --print data_app_crash` / `data_app_anr`.
  - `--symbolicate`: `dwarfdump --uuid` match, then `atos -o <dSYM> -l <load>`.

### Wave 3 (parallel)

**PRF-6 — ✨ feat(perf): React render profiler** (after PRF-5)
- Injected scripts, **written clean-room** (argent's docs describe the approach; none of its code is read into our files):
  - Wrap `__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces[*].startProfiling` / `stopProfiling`.
  - Patch `onCommitFiberRoot` for a fiberID→displayName cache.
  - Bootstrap `react-devtools-core` `connectWithCustomMessagingProtocol` when no DevTools client is attached.
  - Owner marker so concurrent agents don't clobber each other.
- Stop: `getProfilingData()` → `react/commits.json` (actual/self/commit durations, changeDescription, hookTypes, compiler-optimised flag).
- Pipeline:
  - Hot commits: absolute floor (under 16ms OK, 16–50ms warm, over 50ms hot) plus cbrt heat.
  - Per-component reduce, then tag (animated false positives), then rank (renders ≥3 or max ≥30ms).
  - Findings use agent-device's taxonomy (`slow-commit`, `slow-render`, `memo-defeated`, `context-cascade`, `parent-cascade`, `render-storm`, `eager-mount`, `effect-chain`) with `costMs`, `evidence` and `fix`.
  - With `--js`, Hermes samples are correlated inside each hot commit's window.
  - Component source: resolve `_debugSource` / `_debugStack` when present, else grep `cwd` for `function X|const X =`. No tree-sitter.
- Clear errors: `rn_too_old` (below 0.74), `release_build`, `devtools_backend_missing`.

**PRF-7 — ✨ feat(perf): iOS native (xctrace)**
- `xctrace record --template 'Time Profiler' --instrument 'Hangs' [--instrument 'Leaks' --instrument 'Allocations'] --device <udid> --attach <pid> --output native/ios.trace --no-prompt`, spawned detached; stop sends SIGINT and waits.
  - Using `--instrument` means no binary template asset. If that combination fails on a given Xcode, build **our own** `.tracetemplate` in Instruments and commit it under `packages/perf/assets/`. Never copy argent's template.
- Xcode 26.4+: switch to `--all-processes` and filter by pid (`select.ts` logic).
- `--leaks` cold-launches with `--env MallocStackLogging=1 --launch -- <App.app>`.
- Export: `xctrace export --toc`, then `--xpath` for `time-profile`, `potential-hangs` and the Leaks detail. Parse with a streaming regex row parser that resolves `id`/`ref`; must handle 50MB+ fixtures.
- Analyze:
  - Dominant frame: app/third-party, then RN (`RCT`, `Yoga`, `Hermes`, `JSI`), then system (skipped).
  - Thread normalisation (Main, JS/Hermes).
  - CPU over 15% is red, 3–15% yellow.
  - Hangs correlated to samples (top 5 functions, top 3 call chains).
  - Leaks grouped by (type, responsible frame).

**PRF-8 — ✨ feat(perf): Android native (perfetto + simpleperf + trace_processor)**
- Perfetto config textproto piped on stdin: `adb shell perfetto --txt -c - --background-wait -o /data/misc/perfetto-traces/warden-<ts>.pftrace`.
  - Data sources: `linux.perf` 100Hz callstacks scoped to the app, ftrace sched/binder plus atrace (view, gfx, wm, am, input, dalvik), `android.surfaceflinger.frametimeline`, and `process_stats` at 1s.
  - Stop: `kill -TERM`, poll `/proc/<pid>`, `adb pull`, `rm`.
- `--native=simpleperf`: `simpleperf record -e cpu-clock:u -p <pid>` backgrounded; stop with INT, then TERM; report with `simpleperf report --stdio --sort comm,dso,symbol` for the top functions. This path needs no trace_processor.
- **`trace-processor.ts`:**
  - Pinned version and sha256 per `darwin-arm64` / `darwin-x64` / `linux-x64`, cached at `$WARDEN_HOME/tools/trace_processor_shell-<ver>`.
  - If it's missing:
    - Interactive: `ctx.ui.confirm("Download trace_processor (~XX MB) to …?")`.
    - Non-interactive without `--yes`: fail with `tool_missing` and the hint `warden perf tools install trace-processor --yes`.
  - Download streams `fetch` with a stderr progress bar from `Content-Length` (bytes, %, speed). The progress bar goes to stderr only; `--json` stdout stays clean.
  - Verify sha256, `chmod +x`, then write atomically by renaming.
  - Injected `fetch`/`confirm` in tests.
- Queries, run with `trace_processor_shell --query-file`:
  - `cpu-hotspots.sql`.
  - `ui-hangs.sql`: frametimeline `App Deadline Missed` only.
  - `hang-folds-batched.sql`: one query covering every hang.
  - `thread-breakdown.sql`, `memory-rss.sql`.
- Zero samples means a `not_profileable` hint with a manifest snippet: `<profileable android:shell="true"/>`.

### Wave 4 (after waves 2–3)

**PRF-9 — ✨ feat(perf): combined session, report, query, diff**
- `perf start/stop/record` orchestrate the selected capturers, run them in parallel, and stop them in reverse order.
- Alignment uses `{wallMs, deviceWallMs}` anchors.
  - Android clock offset comes from `adb shell date +%s%N` measured at start, with RTT halved.
  - The iOS sim shares the host clock.
- Marks tag commits, hangs and jank windows.
- `report`: merged markdown with sections Summary, Startup, Frames, JS CPU, React, Native CPU, Hangs, Memory, Logs/Crashes, and Next. Correlated items, e.g. "hang 412ms @ 3.2s overlaps commit #14 (FlatList, 180ms) ← mark 'scroll feed'".
- `query`: `commits --by component|window|index|cascade`, `cpu --top|--window|--tree`, `stacks hang|callers|thread|leaks`, `frames --worst`. It re-reads the session files; on Android it re-runs the SQL.
- `diff a b`: per-metric deltas (startup p50, jank %, p95 CPU, PSS, top-N commit cost, top functions) with regression thresholds. Non-zero exit with `--fail-on regress`.

**PRF-11 — ✨ feat(e2e): perf in specs + budgets**
- `device.perf.start(opts)` / `stop()` → typed `PerfReport` in `@delacour/warden-e2e`, reusing `packages/perf` through the CLI or directly.
- `warden e2e <suite> --perf[=react,js,metrics]` writes `perf/` under each attempt dir (`runner/artifacts.ts` `attemptDir`), and `e2e-report.json` links to it.
- Budgets in `warden.config.ts`: `perf: { budgets: { startupColdMs, jankPct, maxCommitMs, p95CpuPct } }`. A breach fails with a `perf_budget` verdict.

### Wave 5

**PRF-12 — 📝 docs(perf): guide, reference, skill, NOTICE**
- `apps/docs/content/docs/guides/perf.mdx` plus `guides/meta.json`.
- `reference/cli.mdx`, plus `reference/environment.mdx` (`WARDEN_TRACE_PROCESSOR`, if added).
- `skills/warden/references/perf.md`, linked from `SKILL.md` (the `skill.test.ts` embed check), covering the workflow: `doctor` → `record`/`start`…`stop` → `report` → `query` → fix → `diff`.
- Root `NOTICE` with agent-device MIT attribution, only for parsers or predicates that were actually adapted. argent was clean-room, so it needs no attribution, but the guide credits it as prior art.

### Wave 6 (later, physical devices; not v1)

**PHY-1 — ✨ feat(core): physical device leasing**
- iOS via `xcrun devicectl list devices --json-output`; Android USB serials, which are not `emulator-*`. Leases are read-only-safe: no erase or shutdown.

**PHY-2 — ✨ feat(perf): physical iOS**
- Pid from `devicectl device info processes`.
- `xctrace --device <udid>` with Time Profiler, Hangs, `Activity Monitor` (memory/CPU) and `Animation Hitches` (real frames).
- Logs via `devicectl device process launch --console`.
- Crashes via `devicectl device info files --domain-type systemCrashLogs` (copy).
- App Launch template for startup. Hermes works over Metro unchanged.

**PHY-3 — ✨ feat(perf): physical Android**
- Same adb paths; flag `profileable`/`debuggable` on release builds.
- Warn when thermal or battery state skews results (`dumpsys thermalservice`, `dumpsys battery`).
- `simpleperf` from the NDK when it isn't on the device.

**PHY-4 — ✅ test(perf): device smoke matrix**
- Manual or CI-labelled runs on one real iPhone and one Pixel, documented in `docs/plans/wdn-prf.md`.

## Critical files

- New: `packages/perf/**`, `apps/cli/src/commands/perf.ts`, `apps/cli/src/commands/perf-collect.ts`, `apps/cli/src/perf/*.ts`.
- Edit:
  - `apps/cli/src/commands/registry.ts`, `apps/cli/src/__snapshots__/help.test.ts.snap`.
  - `apps/cli/src/agent-ui/state.ts` (the `perf` field).
  - `packages/e2e-bench/src/harness/sampler.ts`, re-exported from the new package.
  - `packages/e2e/src/devtools/session.ts`, only if a `Profiler`/`HeapProfiler` stream helper is needed.
  - `packages/e2e/src/device-devtools.ts` (PRF-11).
  - Docs and skill files from PRF-12.
- Copy the plan to `docs/plans/wdn-prf.md` in PRF-1.

## Verification

- Unit: `bun test packages/perf apps/cli/src/perf apps/cli/src/commands/perf*.test.ts`. Fixtures are real captured outputs: gfxinfo, meminfo, am start, ps, xctrace XML, simpleperf report, trace_processor CSV, `.cpuprofile`, React profiling data.
- Repo: `bun run typecheck && bun run check && bun run test`.
- Live iOS (example app):
  1. `warden claim ios --json` and `warden dev ios --json`.
  2. `warden perf doctor`.
  3. `warden perf record --all --duration 15s`, driving scrolls meanwhile with `warden ui gesture …` and `warden perf mark`.
  4. `warden perf report`; check the source-mapped JS hotspots, React findings and xctrace hangs.
  5. `warden perf startup --cold --runs 3`.
  6. `warden ui close --release`.
- Live Android: same flow with `warden claim android`. The first `--native` run must prompt for the trace_processor download with progress. Then `perf diff` two runs.
- A `perf` suite in `apps/example` using `device.perf` plus budgets, run via `warden e2e example`.
- Signoff: `bun run signoff`, plus `native` if `packages/e2e/native/**` was touched.

## Best-practice notes

- Simulator and emulator numbers run on host CPU and GPU, so trust relative changes and diffs, not absolutes. Every report carries a banner saying so. Final perf sign-off belongs on a physical device (PHY wave).
- Dev builds (`__DEV__`, unminified, DevTools hook) inflate JS and React costs. Warn, and recommend `--variant release`/profileable builds for native work. The React profiler needs dev or profiling builds, so document the trade-off.
- Profiler overhead: Hermes sampling at 100µs plus perfetto callstacks. Keep sessions short (≤30s by default, with a hard cap and an auto-stop timer in `perf-collect`) so traces don't blow up the disk; enforce a session-dir size cap and add `perf ls --prune`.
- Leave the device clean: every capturer is stopped by `warden ui close --release` / `release`, and a stale-session sweep (dead pid) runs on `perf start`.
- Privacy: logs, network and heap snapshots can hold PII or tokens. Logs are redacted; heap snapshots and traces are flagged "contains app memory" and never auto-uploaded.
- Licences: argent is clean-room, so implementer subagents get **this plan, not argent source**. The scratchpad clones are not referenced. agent-device-derived code keeps its MIT notice.

## Unresolved questions

1. Should the trace_processor pin be the latest stable at implementation time, or one specific version?
   - a) latest stable, checked in PRF-8
   - b) let the user pick
2. Does `perf crashes` also need Android NDK native tombstones, which need root on non-userdebug emulators?
   - a) best-effort through dropbox
   - b) skip
- Supply chain: trace_processor is pinned with a sha256 and downloaded only after explicit consent, never silently.
