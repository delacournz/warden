# Profile an app (`warden perf`)

Flags: `warden perf <sub> --help`; full docs: guides/perf, reference/cli. Same device rules as `warden ui`: claim first, pass `--udid`/`--serial` on every call.

## Workflow

```bash
warden claim ios --json                    # then warden dev ios --json (JS/React need a dev client)
warden perf doctor --udid $UDID            # fix every fail first
warden perf record --all --duration 15s --udid $UDID    # drive with warden ui meanwhile; `warden perf mark "<label>"` at key moments
warden perf report --json                  # ranked findings; each has evidence, fix, next
warden perf query latest commits --by component         # drill into the worst finding
# edit code
warden perf record --all --duration 15s --relaunch --udid $UDID
warden perf diff <before> latest [--fail-on regress]
warden ui close --release --udid $UDID
```

Need to act between start and stop: `perf start [flags]` ... `perf mark` ... `perf stop`. No capture flag = metrics + frames + logs; `--all` adds JS, React, native.

## Subcommands

Device flags on all device-bound ones: `--udid|--serial|--lease`, `--claim`, `--app <id>`, `--json`. Long tail: `warden perf <sub> --help`.

| Sub | Use | Key flags |
|---|---|---|
| `start` | open a session | `--metrics --frames --logs --js --react --native[=simpleperf] --all`, `--relaunch` (record startup), `--reset` (relaunch + wipe data), `--max-duration <t>` (default 30s, max 5m), `--join` (observe a running one), `--yes` |
| `stop` | end session, write report | `--no-analyze` (report later via `report --rebuild`) |
| `record` | start + wait + stop + report | start flags, `--duration <t>` (default 10s, max 5m), `--no-analyze` |
| `mark <label>` | tag the timeline | needs a running session |
| `report [id]` | merged report (default newest) | `--full` whole report.md, `--rebuild` regenerate from session files |
| `query <id> <topic>` | drill in | topics `commits\|cpu\|stacks\|frames`; `commits --by component\|window\|index\|cascade` (`--size`, `--index <n>`); `cpu --top\|--tree\|--window 2s-5s`; `frames --worst`; `stacks hang\|callers <fn>\|thread\|leaks`; `--limit <n>`; `--rerun` |
| `diff <a> <b>` | before/after | `--fail-on regress` (exit 1), `--threshold <pct>` (default 10%) |
| `metrics` | CPU % + memory over time | `--duration` (default 3s), `--interval` (min 200ms), `--watch` |
| `memory` | memory breakdown | `--snapshot` (iOS memgraph+leaks, Android .hprof; pauses app; needs your lease) |
| `frames` | fps / jank % / worst windows (Android only) | `--reset` clears counters (needs lease) |
| `startup` | cold/warm launch time, median + p90 | `--cold` (default) `--warm`, `--runs 1-20` (default 5), `--method approx\|xctrace` (iOS) |
| `js` | Hermes CPU profile, source-mapped | `--duration`, `--metro <url>` |
| `heap snapshot` / `heap diff <a> <b>` | Hermes heap, constructor deltas between two `.heapsnapshot` files | snapshot needs your lease |
| `react` / `react start` / `react stop` | React render profile | `--duration`, `--take-over` |
| `native [start\|stop]` | native CPU/hangs; no action = one-shot | `--duration`, `--leaks` (iOS, cold-launches), `--flavor perfetto\|simpleperf` (Android), `--analyze <trace>`, `--skip-analysis` |
| `logs` | redacted app logs | `-f`, `--level V\|D\|I\|W\|E\|F`, `--grep`, `--since`, `-n` (default 200) |
| `crashes` | crashes + ANRs | `--since`, `--symbolicate --dsym <p>` (iOS) |
| `ls` | sessions, newest first | `--devices` (candidate devices), `--device <udid>` |
| `doctor` | what profiling needs | fix every fail first |
| `tools install trace-processor` | pinned Perfetto helper | `-y` |

Mutating device flags (`start`, `startup`, `--relaunch`, `--snapshot`): `--claim` or own lease; `--force` drives a device a live `e2e`/`batch`/`run` lease holds; `--allow-mutate-foreign` on others' devices.

## Symptom -> command

| Symptom | Run |
|---|---|
| "feels slow", no idea why | `record --all`, `report` |
| scroll jank / dropped frames (Android) | `frames`; `record --frames --native`; `query <id> frames --worst` |
| UI hang / freeze (iOS) | `record --native`; `query <id> stacks hang` |
| slow startup | `startup --cold --runs 5 --claim`; `record --relaunch` |
| too many re-renders | `react`; `query <id> commits --by component` / `--by cascade` |
| hot JS function | `js`; `query <id> cpu --window 3s-4s [--tree]` |
| memory growing | `metrics --watch`; `memory`; `heap snapshot --claim` twice, `heap diff a b` |
| native leak (iOS) | `native --leaks --claim`; `memory --snapshot --claim` |
| crash / ANR | `crashes --since 1h [--symbolicate --dsym <p>]`, `logs --level E` |
| did my fix help | `record --relaunch` again, `diff <before> <after>` |

## Read these JSON fields

- `report --json` = `report.json`: `findings[]` (severity, kind, `costMs`, `evidence`, `fix`, `next`), plus per-section data (startup, frames, JS, React, native, memory). Do `next` commands literally.
- `report.json` top level: `sessionId`, `device`, `app`, `durationMs`, `stopReason`, `banners`, `summary`, `findings[]`, `sections[]` (`startup frames js-cpu react native-cpu hangs memory logs`), `correlations`, `marks`, `metrics`, `next`.
- `ls --json`: `sessions[]` (`id`, status `running|stopped|aborted|overdue`; overdue = still running past its cap, swept by next `perf start`). `doctor --json`: `{ok, device?, checks[]}`.
- Envelope on failure: `{code, message, hint?}`. Branch on `code`, not text.
- e2e budgets: `warden e2e <suite> --perf[=captures]` (bare = metrics,frames,logs; `all`; or e.g. `react,js`) copies each attempt's report to `<attempt>/perf/`. `perf.budgets` in `warden.config.ts` (`startupColdMs`, `jankPct`, `maxCommitMs`, `p95CpuPct`, `peakMemoryMb`; a suite's value replaces the top-level one per key). In a spec: `device.perf.start(opts)`, `.mark(label)`, `.stop({ budgets })`. Breach = `PERF_BUDGET` error, kind `perf_budget` in `e2e-report.json`.
- Finding kinds: `slow-commit`, `slow-render`, `memo-defeated`, `context-cascade`, `parent-cascade`, `render-storm`, `eager-mount`, `effect-chain`, `startup`, `jank`, `hang`, `cpu-hot`, `memory-growth`, `leak`, `crash`, `anr`, `js-hotspot`, `native-hotspot`. Severity `critical|warn|info`.

People running `warden dev` get the same sessions on keys: `p` start/stop, `P` all captures, `m` mark, `f` frames, `g` report (one session per device, so `session_active` applies). Agents keep to the CLI.

## Errors -> action

| Code | Do |
|---|---|
| `ambiguous_device` | pass `--udid`/`--serial`/`--lease` from the listed candidates |
| `device_unknown` | not a warden device: `warden claim`, never attach to foreign devices |
| `device_foreign`, `device_not_leased` | mutating step needs your lease: `--claim` on a free device. Live foreign lease: pick another device, do not retry |
| `device_busy` | a live `e2e`/`batch`/`run`/`dev` holds it; wait or use another device. `--allow-mutate-foreign` will not override |
| `session_active` | `perf ls`; `perf stop` it, or `--join` to observe. `react`: `--take-over` only if the other profile is yours |
| `session_not_found` | no running session: `perf start` first (e.g. before `mark`) |
| `not_profileable` | Android app must be debuggable or `<profileable android:shell="true"/>`; rebuild, `doctor` checks it |
| `tool_missing` (exit 3) | `warden perf tools install trace-processor --yes` (or `--yes` on the command); iOS: install Xcode / `xcrun` tools |
| `devtools_unavailable` (exit 3) | no Metro/Hermes target: release build or app not running. Run `warden dev` and relaunch the dev client |
| `rn_too_old` | React profiling needs React Native >= 0.74; use `js`/`native` instead |
| `release_build`, `devtools_backend_missing` | React profile needs a dev build with `react-devtools-core`; use a dev client |
| `unsupported` | platform lacks it (iOS `frames`, old runtime); follow the `hint` |
| `app_not_found` | pass `--app <id>` |

## Rules

- Numbers from simulators/emulators: compare relative (`diff`), never quote as absolute.
- Dev builds inflate JS/React cost: say so when reporting; confirm on a profileable build for native work.
- Sessions cap at 30 s by default (`--max-duration`, max 5 m, clamped with a warning); `record --duration` default 10 s; keep them short.
- Traces, heap dumps, `.hprof`, `.memgraph` contain app memory: never paste or upload them. Logs are redacted already.
- Always release: `warden ui close --release` (also stops a running session).
- Viewers: `.cpuprofile` Chrome DevTools/speedscope, `.trace` Instruments, `.perfetto-trace` ui.perfetto.dev, `.hprof` Android Studio, `.memgraph` Xcode.
