# @delacour/warden-e2e-bench

Benchmarks four mobile e2e frameworks on the same app, the same device and the same 8-test parity suite: `warden` (`@delacour/warden-e2e`), Argent, agent-device and tester.army. Private, never published. Plan: [`docs/plans/wdn-bench.md`](../../docs/plans/wdn-bench.md). Published results: `docs/bench/`.

It measures suite wall time, per-test and per-step timings, cold-start cost, prepare/teardown, host and simulator CPU/RSS, residue left on the machine, and the size of each suite's footprint. No LLM is involved anywhere.

## Quick start

From the repo root (`bun install` first):

```bash
bun run bench doctor                                 # every framework installed? prints install hints
bun run bench list                                   # frameworks, platforms, the 8 canonical test ids
bun run bench run --platform ios --runs 3            # full run, all frameworks, claims a sim via warden
bun run bench run --frameworks warden,argent --runs 2 --udid <leased-udid>
bun run bench report .bench/<run-id>                 # re-render report.md / report.html
bun run bench compare .bench/<run-a> .bench/<run-b>  # markdown diff of two runs
```

## Build the app once

The benchmark installs one pinned app on every framework's run. It is built once and stored at `.bench/app/<platform>/` (the `.app` or `.apk` plus a `manifest.json` with the warden fingerprint, sha256, source and commit). Every `bench run` reuses it. `bench run` never builds, fingerprints or calls EAS: it installs the pinned artifact (`simctl install` / `adb install -r`) after claiming the device, and builds it once only when it is missing.

```bash
bun run bench app build --platform ios            # build (warden cache, then a local Expo build) and pin it
bun run bench app build --platform ios --force    # rebuild even though one is pinned
bun run bench app build --platform android --eas  # also look the build up on EAS
bun run bench app status --platform ios           # hash, source, builtAt; fresh or stale, exit 1 when missing or stale
bun run bench app clean --platform ios            # remove the pinned app
bun run bench run --platform ios --app path/to/Example.app   # use a pinned dir or import a bare .app / .apk
```

`app build` resolves the build with `warden app ensure --variant bench` on `apps/example`. Without `--force` it reuses the pinned app without fingerprinting. `app status` compares the pinned hash with `warden app fingerprint --variant bench`.

Rebuild with `--force` after changing `apps/example` or its Expo and React Native dependencies. Changes to `packages/e2e` or warden do not need a rebuild.

### Build on EAS

The app is the Expo project `@delacour/warden` (`extra.eas.projectId` in `app.config.ts`, GitHub base directory `apps/example`), so `bench app build --eas` also looks the `bench` profile up on EAS (`bunx eas-cli`, logged in to the `delacour` account). The `bench` variant in `apps/example/warden.config.ts` is the only place EAS is configured, and `eas.json` holds the Release simulator and APK profile. `.eas/workflows/bench-build.yml` builds both platforms on EAS: run it with `eas workflow:run .eas/workflows/bench-build.yml`, or it runs on pushes to `main` that touch `apps/example/`.

### Baseline on EAS

`apps/example/.eas/workflows/bench-baseline.yml` builds the `bench` iOS app once, then runs one job per framework, each on its own EAS `macos-large` worker with its own simulator (`scripts/eas-bench.sh`). Inputs: `runs` (default `5`), `frameworks` (default all four; a job is skipped unless its framework is named) and `max_minutes` (default `55`: the job stops the bench, keeps the results so far, releases the lease and uploads). argent and agent-device are installed with `bun add -g` on their worker; tester-army comes with `bun install`:

```bash
cd apps/example && bunx eas-cli workflow:run .eas/workflows/bench-baseline.yml -F runs=5
cd apps/example && bunx eas-cli workflow:run .eas/workflows/bench-baseline.yml -F runs=5 -F frameworks=argent,agent-device
```

The build is skipped when EAS already has a `bench` build for the current fingerprint. Each job uploads an `eas-ios-<framework>` artifact (URLs in `eas workflow:view <run-id>`; each unpacks to `Users/expo/bench-results`, with `sim-final.png` showing the simulator when the job left). Copy one to `.bench/eas-ios-<framework>`, then `bun run bench report .bench/eas-ios-<framework>`. A hosted worker idles hotter than a Mac: compare EAS numbers only with EAS numbers from the same worker class.

`bench run` options:

| Flag | Default | Meaning |
|---|---|---|
| `--platform ios\|android` | `ios` | leg to run |
| `--frameworks a,b` | all four | `warden,argent,agent-device,tester-army` |
| `--runs N` | `3` | reps per framework; rep 1 is cold, the rest warm |
| `--retries N` | `0` | forwarded to every framework |
| `--app PATH` | `.bench/app/<platform>` | pinned app dir, or a bare `.app` / `.apk` to import and pin |
| `--udid X` | claim one (`--ttl 4h --label bench`, heartbeat every 60 s) | use a device you already leased (no claim, release or heartbeat: hold that lease yourself, e.g. a long `--ttl` or `warden heartbeat`) |
| `--reboot-between` | off | reboot the device between frameworks |
| `--out DIR` | `.bench/<timestamp>-<platform>` | output dir |
| `--skip-doctor` | off | skip the per-framework doctor |
| `--force` | off | run even when the load average exceeds the core count |
| `--keep-drivers` | off | keep driver apps installed (skip the cold uninstall) |
| `--node-bin PATH` | none | node bin dir to put first on `PATH` for the frameworks |

Exit code: `0` all ok or unsupported, `1` a framework failed, `2` bad arguments, `130` interrupted. Ctrl-C finishes the current phase, tears down, releases the lease and writes results; a second Ctrl-C exits at once.

Device runs take about an hour (4 frameworks x 3 reps x 2-4 min). Keep the Mac awake (the run holds `caffeinate -dims`) and use a dedicated sim.

## Output

```
.bench/<run-id>/
  bench-results.json     schema v1 (src/results/schema.ts), rewritten after every framework
  report.md              summary, per-test matrix, steps, resources (CPU-seconds per rep first), where the CPU goes (per-process table), residue, problems
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

- **Per process.** Each 500 ms tick also records `{ pid, name, scope, cpuSec, rssBytes }` for every host and (iOS) simulator process that used CPU or holds at least 1 MiB (`processes` in `resources.ndjson`; older files lack it). The report's "Where the CPU goes" section shows, per framework, the warm-median rep's rows grouped by label (`warden-simd`, `bun test`, `SimulatorFrameworkBridge-iOS serve`, `xcrun simctl launch`, `backboardd`, `SpringBoard`, the app, …): CPU-seconds, share of the scope, RSS avg and peak, and spawns (distinct pids a tick saw). CPU a bench child used between ticks shows as `<label> (exit charge)` rows. `summary.json` (version 2) carries the same rows as the optional `processes`; `bench compare` diffs them by name.

- **Android `sim`** is `adb shell top -n 1` every 2 s, filtered by name (`src/harness/sampler.ts`, `ANDROID_TARGET`): the app under test and its `.test` apk, `uiautomator`, instrumentation runners (`instrumentation`, which also catches agent-device's `SnapshotInstrumentation`), `com.callstack.agentdevice*`, `com.argent.*` and `warden-uiad`. It is case-insensitive, because helper class names differ in case. A helper that renames its `app_process` (as `warden-uiad` does) shows up under the new name in `top`; add its name there when a framework gains a resident helper with a name this list does not cover. Before this the pattern was case-sensitive and only knew warden's helpers, so other frameworks' drivers were missing from their `sim` column and warden looked heavier than it was (first Android run, `v2-android-r2`: warden 384 MB average against 236 to 268 MB for the others).
- **Host** processes are the framework's process tree plus every pid the bench spawned. The bench keeps every spawned pid for the whole session, and the OS reuses pids, so each pid is stamped with its `ps lstart` the first time the sampler sees it and only counts while that start time matches. A spawned child that had already exited before the sampler first looked is never trusted again. Android's `top` rows are matched by name on every read, so no pid is carried over there.
- **Animation scales.** Warden's Android driver sets `window_animation_scale`, `transition_animation_scale` and `animator_duration_scale` to 0 for its run. Left alone, every framework measured after warden would run on a device with animations off. At bench start the harness records the three values (`adb shell settings get global …`; unset is recorded as unset), `isolate` resets them before every framework's prepare, and the run restores them when it ends. Warden's driver restoring them itself is a separate fix; the harness reset stays as defence in depth. A device that a previous warden run already left at 0 is recorded as 0: reset it by hand (`adb shell settings put global window_animation_scale 1.0`, same for the other two) before a bench run.

The app is the pinned bench app (`.bench/app/<platform>/`, Release, `EXPO_PUBLIC_E2E=1`, built once by `bench app build`). It is installed on the claimed device during prepare, before any framework runs. App state is in memory, so every launch starts signed out on the welcome screen. Between frameworks the harness stops the previous one's daemons, stops the `warden-simd` helper before a non-warden framework (a second accessibility client on one sim degrades its settle from ~260 ms to ~2.5 s), and uninstalls driver apps before a cold rep.

## Per-framework caveats

Each framework expresses the same retries in its own idiom. Gaps that remain are real differences, not hidden easier tests:

| Framework | Selector | Retry and conditionals | Assertion gaps | Other |
|---|---|---|---|---|
| warden | `screen.getByTestId` | built-in options: `tap({ until })` (4 s a press, two re-sends), `openDeepLink` (3 links, 6 s each), `test.use({ systemAlerts: "dismiss" })`, `app.open({ wait: "quiet" })` | none | copied from `apps/example/e2e` minus devtools. The hand-rolled `tapUntil` version it replaced is what the published headline numbers (`docs/bench/*-perf.md`) ran; the idiomatic run is reported beside them |
| argent | `{ id }` | `when:` guards instead of loops (`fragments/next-*.yaml`), nested to cap retaps at 2 | checkbox checked state is not readable; the remaining-count assertion covers the effect | `flow run` uses its own server (`argent server start/stop`) |
| agent-device | `id="..."` | `.ad` scripts have no retry or conditional: plain `wait` / `press` | none | needs `prepare ios-runner` and a daemon; cold cost is measured |
| tester-army | `screen.getByTestId` | its own copy of the hand-rolled `tapUntil` helpers warden used before PERF-6.3 | none | `AGENT_DEVICE_STATE_DIR` is private (`BENCH_TESTER_ARMY_STATE_DIR`) so it never shares a daemon with agent-device; needs Node 24 on `PATH` |

A native test name that does not map to a canonical id is a parity breach: that framework is `failed` in phase `run`.

## Prerequisites

`bun run bench doctor` checks all of these and prints the install command for anything missing. The harness never installs global tools.

| Framework | Needs |
|---|---|
| warden | workspace deps; iOS helper built with `bun run --cwd packages/e2e native:build` |
| argent | `bun add -g @swmansion/argent` |
| agent-device | `bun add -g agent-device` |
| tester-army | `bun install` (pinned `e2e` and `@e2e-dev/mobile`), Node `^22.22.3 \|\| >=24.8`, e.g. `nvm install 24` |

Also: Xcode with a booted-capable simulator (iOS) or an Android emulator, and `warden` able to claim them.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `BENCH_NODE_BIN` | tester-army | node bin dir put first on `PATH` when the default Node is too old (default `~/.nvm/versions/node/v24.19.0/bin`); `--node-bin` sets it per run |
| `BENCH_TESTER_ARMY_STATE_DIR` | tester-army | private `AGENT_DEVICE_STATE_DIR` (default `~/.agent-device-bench/tester-army`) |

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
