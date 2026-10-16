# @delacour/warden-e2e-bench

Benchmarks six mobile e2e frameworks on the same app, the same device and the same 8-test parity suite: `warden` (`@delacour/warden-e2e`), Maestro, Argent, agent-device, tester.army and Detox. Private, never published. Plan: [`docs/plans/wdn-bench.md`](../../docs/plans/wdn-bench.md). Published results: `docs/bench/`.

It measures suite wall time, per-test and per-step timings, cold-start cost, prepare/teardown, host and simulator CPU/RSS, residue left on the machine, and the size of each suite's footprint. No LLM is involved anywhere.

## Quick start

From the repo root (`bun install` first):

```bash
bun run bench doctor                                 # every framework installed? prints install hints
bun run bench list                                   # frameworks, platforms, the 8 canonical test ids
bun run bench run --platform ios --runs 3            # full run, all frameworks, claims a sim via warden
bun run bench run --frameworks warden,maestro --runs 2 --udid <leased-udid>
bun run bench report .bench/<run-id>                 # re-render report.md / report.html
bun run bench compare .bench/<run-a> .bench/<run-b>  # markdown diff of two runs
```

`bench run` options:

| Flag | Default | Meaning |
|---|---|---|
| `--platform ios\|android` | `ios` | leg to run |
| `--frameworks a,b` | all six | `warden,maestro,argent,agent-device,tester-army,detox` |
| `--runs N` | `3` | reps per framework; rep 1 is cold, the rest warm |
| `--retries N` | `0` | forwarded to every framework |
| `--udid X` | claim one | use a device you already leased (no claim, no release) |
| `--reboot-between` | off | reboot the device between frameworks |
| `--out DIR` | `.bench/<timestamp>-<platform>` | output dir |
| `--skip-doctor` | off | skip the per-framework doctor |
| `--force` | off | run even when the load average exceeds the core count |
| `--keep-drivers` | off | keep driver apps installed (skip the cold uninstall) |
| `--node-bin PATH` | none | node bin dir to put first on `PATH` for the frameworks |

Exit code: `0` all ok or unsupported, `1` a framework failed, `2` bad arguments, `130` interrupted. Ctrl-C finishes the current phase, tears down, releases the lease and writes results; a second Ctrl-C exits at once.

Device runs take about an hour (6 frameworks x 3 reps x 2-4 min). Keep the Mac awake (the run holds `caffeinate -dims`) and use a dedicated sim.

## Output

```
.bench/<run-id>/
  bench-results.json     schema v1 (src/results/schema.ts), rewritten after every framework
  report.md              summary, per-test matrix, steps, resources, residue, problems
  report.html            one self-contained file, inline data and SVG charts, no CDN
  logs/                  one log per framework and phase (<fw>.<phase>)
  artifacts/<fw>/rep-<n>/  native reporter output, resources.ndjson, failure artifacts
```

`.bench/` is gitignored. To publish a run, commit its `report.md` as `docs/bench/<platform>-<date>.md`.

## Fairness rules

These are printed in every report:

- Same `.app` for every framework (sha256 recorded)
- Zero LLM calls
- Same assertions per canonical test id
- Same retry helpers (dropped first tap, dropped deep link, system alerts)
- Fresh app launch per test
- `retries=0`
- Frameworks run sequentially
- `caffeinate -dims` held for the run
- Warm medians exclude rep 1 (cold)
- Machine-readable reporters only
- Host otherwise idle; load average recorded
- Android `sim` counts the app and every framework's on-device helpers, matched case-insensitively
- Host processes are tracked by pid and start time, so a reused pid is never counted
- Android animation scales are reset to the device's original values before every framework and restored at the end

Resource sampling, in detail:

- **Android `sim`** is `adb shell top -n 1` every 2 s, filtered by name (`src/harness/sampler.ts`, `ANDROID_TARGET`): the app under test and its `.test` apk, `uiautomator`, instrumentation runners (`instrumentation`, which also catches agent-device's `SnapshotInstrumentation`), `dev.mobile.maestro*`, `com.callstack.agentdevice*`, `com.argent.*` and `warden-uiad`. It is case-insensitive, because helper class names differ in case. A helper that renames its `app_process` (as `warden-uiad` does) shows up under the new name in `top`; add its name there when a framework gains a resident helper with a name this list does not cover. Before this the pattern was case-sensitive and only knew warden's helpers, so Maestro's and agent-device's drivers were missing from their `sim` column and warden looked heavier than it was (`docs/bench/android-2026-10-16.md`: warden 384 MB average against 236 to 268 MB for agent-device and Maestro).
- **Host** processes are the framework's process tree plus every pid the bench spawned. The bench keeps every spawned pid for the whole session, and the OS reuses pids, so each pid is stamped with its `ps lstart` the first time the sampler sees it and only counts while that start time matches. A spawned child that had already exited before the sampler first looked is never trusted again. Android's `top` rows are matched by name on every read, so no pid is carried over there.
- **Animation scales.** Warden's Android driver sets `window_animation_scale`, `transition_animation_scale` and `animator_duration_scale` to 0 for its run. Left alone, every framework measured after warden would run on a device with animations off. At bench start the harness records the three values (`adb shell settings get global …`; unset is recorded as unset), `isolate` resets them before every framework's prepare, and the run restores them when it ends. Warden's driver restoring them itself is a separate fix; the harness reset stays as defence in depth. A device that a previous warden run already left at 0 is recorded as 0: reset it by hand (`adb shell settings put global window_animation_scale 1.0`, same for the other two) before a bench run.

The build comes from `warden app ensure` (Release, `EXPO_PUBLIC_E2E=1`) and runs once before any framework. App state is in memory, so every launch starts signed out on the welcome screen. Between frameworks the harness stops the previous one's daemons, stops the `warden-simd` helper before a non-warden framework (a second accessibility client on one sim degrades its settle from ~260 ms to ~2.5 s), and uninstalls driver apps before a cold rep.

## Per-framework caveats

Each framework expresses the same retries in its own idiom. Gaps that remain are real differences, not hidden easier tests:

| Framework | Selector | Retry and conditionals | Assertion gaps | Other |
|---|---|---|---|---|
| warden | `screen.getByTestId` | shared `tapUntil` / `openDeepLink` helpers | none | reference suite, copied from `apps/example/e2e` minus devtools |
| maestro | `id:` | `retry:` blocks rerun the tap and the wait together (`common/tap-until.yaml`, `next-step.yaml`) | checkbox state read via accessibility text `checkbox, checked` | JVM driver; step durations include Maestro's own polling, compare per-test totals |
| argent | `{ id }` | `when:` guards instead of loops (`fragments/next-*.yaml`), nested to cap retaps at 2 | checkbox checked state is not readable; the remaining-count assertion covers the effect | `flow run` uses its own server (`argent server start/stop`) |
| agent-device | `id="..."` | `.ad` scripts have no retry or conditional: plain `wait` / `press` | none | needs `prepare ios-runner` and a daemon; cold cost is measured |
| tester-army | `screen.getByTestId` | same `tapUntil` helpers as warden | none | `AGENT_DEVICE_STATE_DIR` is private (`BENCH_TESTER_ARMY_STATE_DIR`) so it never shares a daemon with agent-device; needs Node 24 on `PATH` |
| detox | `by.id` | `tapUntil` port in `helpers/flows.js` | none | best effort: Detox 20.51 supports RN up to 0.84, the app is 0.86. Any attach or sync failure is reported as `unsupported`. System alerts are avoided by pre-granted permissions, not dismissed. Android needs an instrumented build, so it is `unsupported` unless `BENCH_DETOX_ANDROID=1` |

A native test name that does not map to a canonical id is a parity breach: that framework is `failed` in phase `run`.

## Prerequisites

`bun run bench doctor` checks all of these and prints the install command for anything missing. The harness never installs global tools.

| Framework | Needs |
|---|---|
| warden | workspace deps; iOS helper built with `bun run --cwd packages/e2e native:build` |
| maestro | `brew install maestro`, Java 17+ (`brew install openjdk@21`) |
| argent | `bun add -g @swmansion/argent` |
| agent-device | `bun add -g agent-device` |
| tester-army | `bun install` (pinned `e2e` and `@e2e-dev/mobile`), Node `^22.22.3 \|\| >=24.8`, e.g. `nvm install 24` |
| detox | `bun install` (pinned `detox`, `jest`), iOS: `brew tap wix/brew && brew install applesimutils` |

Also: Xcode with a booted-capable simulator (iOS) or an Android emulator, and `warden` able to claim them.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `BENCH_NODE_BIN` | tester-army | node bin dir put first on `PATH` when the default Node is too old (default `~/.nvm/versions/node/v24.19.0/bin`); `--node-bin` sets it per run |
| `BENCH_TESTER_ARMY_STATE_DIR` | tester-army | private `AGENT_DEVICE_STATE_DIR` (default `~/.agent-device-bench/tester-army`) |
| `BENCH_DETOX_ANDROID` | detox | `1` opts into the Android leg (needs an instrumented build, see the plan's A6b) |

## Adding a framework

1. Add the id to `FRAMEWORK_IDS` in `src/adapters/adapter.types.ts`.
2. Write `src/adapters/<id>.ts` exporting a `BenchAdapter`: `id`, `supports`, `doctor` (version or `reason` + `installHint`), `prepare` (cold warm-up that is not part of a test), `run` (one full suite pass, parsed into canonical `TestResult[]`), `teardown` (kill daemons), and `residuePatterns` (processes, driver bundle ids, dirs). All side effects go through the injected `ctx.exec`; the adapter must never spawn directly.
3. Put the native reporter parser in `src/adapters/parse/` and a real output sample in `src/adapters/fixtures/`; test against the fixture with `fakeExec`.
4. Register it in `src/adapters/registry.ts`.
5. Add a `native.<id>` name for every test in `suites/manifest.json` (`bench doctor` fails a suite missing an id).
6. Create `suites/<id>/` with all 8 tests, encoding the same retries as `apps/example/e2e/helpers/flows.ts`. Add a caveats row to this README and the docs guide.

## Adding a canonical test

1. Add the id to `CANONICAL_IDS` in `src/results/schema.ts`.
2. Add an entry to `suites/manifest.json`: `title`, expected `steps`, and a `native` name for every framework.
3. Write the test in every `suites/<framework>/`, with the same assertions and the same retry helpers.
4. Run `bun run --cwd packages/e2e-bench test` and `bun run bench doctor`.

## Development

```bash
bun run --cwd packages/e2e-bench test       # fixture-based, never spawns
bun run --cwd packages/e2e-bench typecheck
bun run --cwd packages/e2e-bench check
```

See [AGENTS.md](AGENTS.md) for the layout and rules.
