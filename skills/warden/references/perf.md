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
- `ls --json`: `sessions[]` (`id`, status `running|stopped|aborted|overdue`). `doctor --json`: `{ok, device?, checks[]}`.
- Envelope on failure: `{code, message, hint?}`. Branch on `code`, not text.
- e2e budgets: `warden e2e <suite> --perf[=captures]` (bare = metrics,frames,logs; `all`; or e.g. `react,js`) copies each attempt's report to `<attempt>/perf/`. `perf.budgets` in `warden.config.ts` (`startupColdMs`, `jankPct`, `maxCommitMs`, `p95CpuPct`, `peakMemoryMb`; a suite's value replaces the top-level one per key). In a spec: `device.perf.start(opts)`, `.mark(label)`, `.stop({ budgets })`. Breach = `PERF_BUDGET` error, kind `perf_budget` in `e2e-report.json`.
- Finding kinds worth knowing: `slow-commit`, `slow-render`, `memo-defeated`, `context-cascade`, `parent-cascade`, `render-storm`, `js-hotspot`, `jank`, `crash`, `anr`, `memory-growth`, `startup`.

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
- Sessions cap at 30 s by default (max 5 m); keep them short.
- Traces, heap dumps, `.hprof`, `.memgraph` contain app memory: never paste or upload them. Logs are redacted already.
- Always release: `warden ui close --release` (also stops a running session).
- Viewers: `.cpuprofile` Chrome DevTools/speedscope, `.trace` Instruments, `.perfetto-trace` ui.perfetto.dev, `.hprof` Android Studio, `.memgraph` Xcode.
