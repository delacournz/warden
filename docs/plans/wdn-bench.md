# WDN-BENCH — `@delacour/warden-e2e-bench`: benchmark mobile e2e frameworks against warden-e2e

Plan ID: **WDN-BENCH** · Base: child Orca worktree of `cetus` (`feature/faster-local-e2e-runner` @ `f7806fc`), branch `feature/e2e-bench` · Copy this file to `docs/plans/wdn-bench.md` in phase B1 (repo convention) · Execution: hand off to a Claude agent in the child worktree (user decision 2026-10-16).

## Context

`@delacour/warden-e2e` (PR #25) replaced tester.army/agent-device/argent as warden's e2e stack on the claim that it is faster (no runner app, no daemon, host-side HID + in-sim AX bridge). Nothing in the repo measures that claim: `warden ui bench` times single driver ops, not whole suites, and no other framework is wired up. This plan adds a workspace package that runs the **same parity suite** (the example app's 8 flows, minus the warden-only `devtools` flow) through **six frameworks**, strictly one framework at a time on the same leased device, and writes a comparable report (Markdown + self-contained HTML) covering suite wall time, per-test and per-step timings, cold-start, teardown, host resources, residue and footprint. Platforms: **iOS and Android** (user decision). Detox is **best-effort** (its matrix stops at RN 0.84; the app is RN 0.86 / Expo 57): the adapter reports `unsupported` with the error rather than failing the run.

Frameworks (name → runner → native timing data → installed today):

| id | runner | per-test | per-step | installed / latest |
|---|---|---|---|---|
| `warden` | `bun test --preload @delacour/warden-e2e/preload <flows>` (env `WARDEN_UDID`, `WARDEN_BUNDLE_ID`, `WARDEN_PLATFORM`, `WARDEN_E2E_OUT`) | `results.jsonl` (`packages/e2e/src/runner/results.ts` `readResults`) | `trace.jsonl` (`runner/trace.ts` `traceEventSchema`) | workspace |
| `maestro` | `maestro --udid <id> test <dir> --format junit --output <xml> --test-output-dir <dir> [--no-reinstall-driver]` | junit `time` | `commands.json` `{command,status,duration}` per flow | brew 2.8.0 / 2.11.0 (Java 17+, openjdk@21 present) |
| `argent` | `argent flow run <dir> --device <id> --platform ios\|android --json` (`.yaml` flows, `launch:`/`tap:`/`type:`/`await:`/`assert:`/`tool:`) | JSON report per flow | steps in the JSON report (`--json-stream` NDJSON for single flows) | bun global 0.27.0 / 0.29.0 |
| `agent-device` | `agent-device test '<dir>/*.ad' --platform ios --udid <id> \| --serial <s> --reporter junit:<xml> --artifacts-dir <dir> --verbose` | junit | `replay-timing.ndjson` per attempt under `--artifacts-dir` | bun global 0.21.20 / 0.21.28 (needs `prepare ios-runner`, daemon) |
| `tester-army` | `e2e run --reporter list,json,junit --output <dir>` with `e2e.config.ts` (`@e2e-dev/mobile` `mobile({platform, device, session})`, built on agent-device 0.21.25) | `report.json` | `--debug` phase timings only | devDep `e2e` 0.21.1 + `@e2e-dev/mobile` 0.12.2; Node `^22.22.3 \|\| >=24.8` (nvm v24.19.0 present) |
| `detox` | `detox test -c ios.sim.release --json --outputFile <f>` (jest 29, `.detoxrc.ts` with `devices.simulator.device.id`, `apps.ios.release.binaryPath` = warden's cached `.app`) | jest json | none (`--record-timeline` not in 20.x CLI) | devDep detox 20.51.3 + jest ^29; `applesimutils` (brew tap wix/brew) not installed → `doctor` reports it |

Key facts the adapters rely on:
- The app is already built, cached and installable by warden: `warden app ensure ios|android --project example --udid <id> --json` → `{appPath, hash, source, installed}` (`packages/core/src/builds/ensure.ts`). Every framework drives **that same binary** (Release, `EXPO_PUBLIC_E2E=1` baked in). State is in-memory so a fresh launch always starts signed-out on the welcome screen; no data reset needed between tests.
- Devices come from warden: `bun apps/cli/src/cli.ts claim ios|android --json` → `{leases:[{leaseId,udid,...}]}`; release **exactly those lease ids** (never `--mine`, see memory). Precedent: `scripts/smoke/ui-bench.ts` (`parseClaim`, `warden()` spawn of `apps/cli/src/cli.ts`).
- Flakiness the existing flows work around (dropped first Next press, dropped tab/row tap after sign-in, deep-link retry, system alert dismiss): every parity suite must encode the **same** retries so no framework gets an easier test (`apps/example/e2e/helpers/flows.ts`: `nextStep`, `tapUntilVisible`, `openDeepLink`, `expectTodosAfterSignIn`; `ids.ts` is the testID map).
- testIDs → selectors: Maestro `id:`, Argent `{ id: … }`, agent-device `id="…"`, tester.army `screen.getByTestId`, Detox `by.id`, warden `screen.getByTestId`. Android exposes testID as resource-id / view tag; Maestro/agent-device/Argent map it; verify in B11.
- The old tester.army suite exists in git: `git show b43e121:apps/example/e2e.config.ts` and `git show b43e121:apps/example/e2e/*.e2e.ts` + `helpers/` — reuse nearly verbatim for the `tester-army` suite.
- warden-simd collides with any second AX/quiescence client on the same sim (settle degrades 260 ms → 2.5 s): the harness **stops warden's helper** (`warden-simd --socket ~/.warden/simd/<udid>.sock`, see `apps/cli/src/agent-ui/helper.ts` `stopHelper`) before any other framework runs, and stops every other framework's daemons before warden runs.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | New workspace package `packages/e2e-bench` (`@delacour/warden-e2e-bench`, private, never published). Suites live inside it under `suites/<framework>/`; the example app is untouched except for an optional Detox Android config plugin (B8b, behind a flag). | Keeps six frameworks' deps (jest, detox, e2e, @e2e-dev/mobile) out of `apps/example`; the Release build fingerprint stays unchanged so warden's cache is reused. |
| 2 | Harness = TypeScript under `src/` run with `bun src/cli.ts` (`bun run bench …` from the package; root script `bench`). Adapters implement one `BenchAdapter` interface; the orchestrator runs frameworks **strictly sequentially** with teardown + residue check between them. | Same shape as `scripts/smoke/ui-bench.ts`, side effects injected (`exec`, `now`, `spawn`) so every module has a colocated `bun test`. |
| 3 | Rep model: `--runs N` (default 3). Rep 1 is **cold** (driver apps uninstalled from the sim and daemons killed before it), reps 2..N are **warm**. Suite/test medians use warm reps only; cold-start cost = rep-1 overhead. | Separates "install a runner on the sim" from steady-state speed, which is what the comparison is about. |
| 4 | Same device for all frameworks; no sim reboot by default; `--reboot-between` reboots (simctl shutdown/boot or emulator restart) between frameworks for cleaner cold numbers. | Reboots cost minutes; keep optional. |
| 5 | Zero LLM anywhere: Argent `flow run` (no agent), agent-device `test` on `.ad` scripts, tester.army locator-only tests (no `agent.*`), Maestro YAML, Detox jest, warden specs. `retries = 0` for every framework by default (`--retries` forwarded uniformly). | Determinism; equal footing. |
| 6 | Canonical parity test ids (8): `onboarding/steps-to-sign-in`, `sign-in/field-errors`, `sign-in/locked-account`, `sign-in/valid-credentials`, `todos/add-complete-filter`, `todo-detail/open-toggle-delete`, `todo-detail/deep-link`, `settings/account-switches-sign-out`. `suites/manifest.json` maps each framework's native test name/file → canonical id and lists the expected step labels. | Reports join on canonical ids; a suite missing an id fails `bench doctor`. |
| 7 | Report: `bench-results.json` (schema below) + `report.md` + `report.html` (single file, inline JSON, inline SVG charts, no CDN). `bench report <dir>` regenerates; `bench compare <a> <b>` diffs two runs. | User decision: Markdown + static HTML. |
| 8 | Android legs run the same adapters with `--platform android` (Maestro `--udid <serial>`, Argent `--device <serial> --platform android`, agent-device `--serial`, tester.army `mobile({platform:"android"})`, warden `WARDEN_PLATFORM=android`). Detox Android needs instrumentation in the app build, so it ships as `unsupported` unless `BENCH_DETOX_ANDROID=1` and the `@config-plugins/detox` phase (B8b) was applied. | iOS + Android (user decision) without changing the shared Release build. |
| 9 | Framework versions are **recorded, not managed**: `doctor` prints installed vs latest known and the exact install commands; the harness never installs global tools (brew/bun global). Package-local tools (tester.army, detox, jest) are pinned devDeps. | Reproducibility + no surprise installs on the host. |
| 10 | tester.army needs Node ≥22.22.3: the adapter prepends `BENCH_NODE_BIN` (default `~/.nvm/versions/node/v24.19.0/bin`) to `PATH` when `node -v` is too old, and records the node version used. | Known failure mode (memory `e2e-node-version`). |

## Architecture

```
packages/e2e-bench/
  package.json  tsconfig.json  biome.jsonc  AGENTS.md  README.md  .gitignore (.bench/, suites/detox/artifacts, suites/tester-army/.e2e)
  suites/
    manifest.json                       canonical ids → per-framework test names + expected step labels
    warden/     *.e2e.ts  helpers/       copies of apps/example/e2e (minus devtools) importing @delacour/warden-e2e; ids.ts shared
    maestro/    *.yaml  common/          one flow per canonical test, runFlow fragments for sign-in
    argent/     *.yaml                   e2e flows (`launch:` first), fragments for sign-in via `run:`
    agent-device/ *.ad                   replay scripts (`context platform=…`, `open`, `press id="…"`, `fill`, `wait`, `is`, `close`)
    tester-army/ e2e.config.ts *.e2e.ts helpers/   from git b43e121, locator-only
    detox/      .detoxrc.ts jest.config.js *.test.ts helpers/
  src/
    cli.ts                              bench run | doctor | report | compare | list
    args.ts                             flag parsing (pattern: scripts/smoke/ui-bench.ts SETTERS)
    harness/
      device.ts                         claim/release via apps/cli/src/cli.ts (--json), platform legs
      app.ts                            warden app ensure --json → {appPath, hash}; install on device
      phases.ts                         doctor → prepare → run reps → teardown → residue, timed with a monotonic clock
      sampler.ts                        host process-tree CPU/RSS sampler (ps, 500 ms) + sim/emulator process CPU
      residue.ts                        pgrep patterns + installed driver apps + dirs written outside out dir
      isolation.ts                      stop warden-simd socket helper, argent server stop, agent-device daemon stop --clean, uninstall driver apps, optional reboot
      exec.ts                           injected spawn/exec with timeouts, log capture per phase
    adapters/
      adapter.types.ts                  BenchAdapter, FrameworkId, RunContext, discriminated results
      warden.ts  maestro.ts  argent.ts  agent-device.ts  tester-army.ts  detox.ts   (+ *.test.ts with fixture outputs under src/adapters/fixtures/)
      parse/   junit.ts  maestro-commands.ts  argent-report.ts  ad-timing.ndjson.ts  tester-report.ts  jest-json.ts  warden-results.ts
    results/
      schema.ts                         zod schema + TS types for bench-results.json (versioned)
      stats.ts                          median, p95, min, max, stddev, CV, ratio-to-fastest
      footprint.ts                      LOC/bytes of suite sources, node_modules size for package-local deps, binary sizes, DerivedData dirs
    report/
      markdown.ts  html.ts  svg.ts      report.md / report.html (inline data + SVG bar/box charts); compare.ts
  .bench/<iso>/                         gitignored run output: bench-results.json, report.md, report.html, logs/, artifacts/<framework>/rep-<n>/…
```

Adapter contract (`src/adapters/adapter.types.ts`):

```ts
export type FrameworkId = "warden" | "maestro" | "argent" | "agent-device" | "tester-army" | "detox";
export type Platform = "ios" | "android";
export type RunContext = { platform: Platform; udid: string; bundleId: string; appPath: string; outDir: string; cold: boolean; retries: number; env: NodeJS.ProcessEnv; exec: Exec; log: (line: string) => void };
export type Doctor = { ok: true; version: string; notes: string[] } | { ok: false; reason: string; installHint: string };
export type BenchAdapter = {
  id: FrameworkId; supports: readonly Platform[];
  doctor(ctx): Promise<Doctor>;
  prepare(ctx): AsyncResult<void>;          // cold warm-up that is NOT part of a test (agent-device prepare ios-runner, argent server start, detox nothing, maestro nothing)
  run(ctx): AsyncResult<RepResult>;         // one full suite pass; parses native output into canonical TestResult[]
  teardown(ctx): AsyncResult<void>;         // kill daemons, stop servers; measured
  residuePatterns: { processes: RegExp[]; driverBundleIds: string[]; dirs: string[] };
};
```

Results schema (`src/results/schema.ts`, zod, `version: 1`):

```ts
BenchRun { schemaVersion: 1, id, startedAt, endedAt, host { model, cpu, cores, memBytes, macos, xcode, java, node, bun, warden, loadAvgAtStart }, device { platform, udid, name, runtime, leaseId }, app { bundleId, appPath, hash /* warden build hash */, sha256, bytes }, options { runs, retries, rebootBetween, frameworks, caffeinated }, frameworks: FrameworkResult[] }
FrameworkResult =
  | { framework, status: "unsupported", version?, reason }
  | { framework, status: "failed", version, phase: "doctor"|"prepare"|"run"|"teardown", error, partial?: RepResult[] }
  | { framework, status: "ok", version, phases { prepareMs, teardownMs }, reps: RepResult[], resources { host: Series, sim: Series }, residue { processes: string[], driverApps: string[], paths: {path, deltaBytes}[] }, footprint { testSourceLoc, testSourceBytes, depsBytes, binaryBytes, notes[] }, stats: FrameworkStats /* derived, recomputable */ }
Series { cpuAvgPct, cpuPeakPct, rssAvgBytes, rssPeakBytes, samples, cpuSeconds?, cpuRatePct?, byGroup?: Partial<Record<"bun-test"|"warden-simd"|"warden-cli"|"adb"|"emulator"|"other", { cpuSeconds, rssAvgBytes, rssPeakBytes }>> }   // raw ticks in artifacts/<fw>/rep-<n>/resources.ndjson; FrameworkResult.resources is whole-framework
RepResult { index, cold, wallMs, wallSource: "harness", startedAt, tests: TestResult[], rawArtifactDir, resources?: { window { startMs, endMs }, host: Series, sim: Series, cpuSeconds, rssPeakBytes } /* timed run only; the CPU headline is host cpuSeconds per rep */ }
TestResult { id: CanonicalId, nativeName, status: "passed" | "failed" | "skipped" | "timed-out" | "missing" /* manifest id absent from output */, durationMs, steps?: { kind, label, ms, status }[], error?, artifacts?: { kind: "screenshot"|"video"|"log"|"junit"|"json", path }[] }
FrameworkStats { warmSuiteWall: Dist, coldSuiteWallMs, perTest: Record<CanonicalId, Dist & { ratioToFastest, passRate, flakeRate }>, overheadMs /* median(wall − Σ tests) */, coldStartMs /* prepareMs + rep1.test[0] − median(warm test[0]) */, firstTestOverheadMs, prepareMs, teardownMs, stepLatency?: Dist, passRate, flakeRate, ratioToFastestSuite }
Dist { n, median, p95, min, max, stddev, cvPct }   // reuse percentile from apps/cli/src/agent-ui/bench.ts
```

Unmapped native test names in a framework's output are a parity breach → that framework's result is `failed` with phase `run`. All harness timings come from `Bun.nanoseconds()`; native durations are stored as-is.

Stats per framework (warm reps unless stated): suite wall median/p95/min/max/CV; per canonical test median/p95/min/max/stddev/CV + ratio to fastest framework; overhead = suite wall − Σ test durations; per-step latency distribution where steps exist; pass rate + flake rate across reps; cold-start cost = rep-1 wall − median(warm wall) and prepare ms; teardown ms; residue list; footprint. Resource sampler: every 500 ms `ps -axo pid,ppid,rss,%cpu,comm`, walk the tree from the spawned pid plus known daemon pids matched by `residuePatterns.processes`; sim CPU from the `launchd_sim` tree of the device (`SimDevice` pid via `xcrun simctl spawn … launchctl`? → simpler: `ps` filtered by `<udid>` in args); emulator via `adb shell top -n 1 -b` sampled per 2 s. Store peak RSS, avg CPU, sample count.

Isolation sequence between frameworks (`harness/isolation.ts`): teardown(previous) → kill by `residuePatterns.processes` (`warden-simd`, `argent.*simulator-server|ax-service|tool-server`, `agent-device.*daemon`, `xctest|XCTRunner.*maestro|agent-device`, `java.*maestro`, `detox.*`) → uninstall driver apps (`dev.mobile.maestro-driver-iosUITests.xctrunner`, agent-device's `*.xctrunner`, Android `dev.mobile.maestro*`) only when the next rep is cold → optional reboot → `xcrun simctl terminate <udid> <bundleId>` → start next framework. Fairness rules (recorded in the report header): same `.app`/`.apk` (sha256 recorded, `app ensure` runs once before any framework), no LLM, same assertions per canonical id, same retry helpers, fresh launch per test, `retries=0`, sequential, `caffeinate -dims` held for the run, warm-up excluded from warm medians, machine-readable reporters only (no video unless a framework forces it, noted in `footprint.notes`), host otherwise idle (abort when 1-min load average > cores unless `--force`; load recorded). Driver runner apps left on the sim after a framework are listed under `residue.driverApps`; they are uninstalled only before that framework's next cold rep (or with `--uninstall-runners` in teardown).

## Phases

Issue titles: `warden-e2e-bench <ID> - <gitmoji> <type>: <desc>`.

### Workspace + scaffold (B0–B1)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-BENCH-B0 | 🔧 chore: child Orca worktree | — | From `cetus`: `orca worktree create --repo id:a3a2a741-0c71-4e4c-8b51-24ad36c526ea --name e2e-bench --parent-worktree active --base-branch feature/faster-local-e2e-runner --agent claude --prompt "<this plan path + instructions>" --json`; branch renamed/created `feature/e2e-bench`; `bun install` (repo setup hook) green; `orca worktree set --comment` used at checkpoints. |
| WDN-BENCH-B1 | ✨ feat(bench): package scaffold + types + manifest | B0 | `packages/e2e-bench` per AGENTS checklist (`@delacour/warden-e2e-bench`, scripts `fmt/lint/check/typecheck/test/bench`, tsconfig `composite:false` like `scripts/smoke`, biome `extends "//"`); `src/adapters/adapter.types.ts`, `src/results/schema.ts` + `stats.ts` (+ tests); `suites/manifest.json` with the 8 canonical ids; root `package.json` script `bench`; `docs/plans/wdn-bench.md` = this plan; root `typecheck`/`check`/`test` green. |

### Harness (H)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-BENCH-H1 | ✨ feat(bench): device + app harness | B1 | `harness/device.ts` claims via `bun apps/cli/src/cli.ts claim <platform> --json` (or `--udid` to reuse a leased device), releases exactly its lease ids; `harness/app.ts` runs `app ensure <platform> --project example --udid … --json` and returns `{appPath, hash}`; tests with fake exec. |
| WDN-BENCH-H2 | ✨ feat(bench): phases, sampler, residue, isolation | B1 | `phases.ts` timed with `performance.now()`; `sampler.ts` process-tree CPU/RSS (parsed `ps` fixtures); `residue.ts` (pgrep, `simctl listapps` / `pm list packages` for driver apps, dir sizes); `isolation.ts` (stop warden-simd socket helper, `argent server stop`, `agent-device daemon stop --clean`, driver uninstall when cold, `--reboot-between`); all unit-tested with injected exec. |
| WDN-BENCH-H3 | ✨ feat(bench): CLI + orchestrator | H1,H2 | `bench run [--platform ios\|android] [--frameworks a,b] [--runs 3] [--retries 0] [--udid X] [--reboot-between] [--out dir] [--skip-doctor]`, `bench doctor`, `bench list`; runs frameworks sequentially, writes `bench-results.json` incrementally after each framework (crash-safe), logs per phase under `logs/`; `caffeinate` held; Ctrl-C releases leases and tears down. |

### Adapters + parity suites (A) — one subagent each, all depend on B1 only

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-BENCH-A1 | ✨ feat(bench): warden adapter + suite | B1 | `suites/warden/*.e2e.ts` = `apps/example/e2e` minus devtools (helpers copied, `ids.ts` shared via import of `apps/example/e2e/helpers/ids.ts` or a copy); runner argv mirrors `apps/cli/src/e2e/bun-runner.ts` `runnerArgv` with `WARDEN_E2E_OUT`; parses `results.jsonl` via `readResults` and `trace.jsonl` steps; prepare = spawn the socket helper and one snapshot (`warden ui snapshot --udid`), teardown = stop helper. |
| WDN-BENCH-A2 | ✨ feat(bench): maestro adapter + suite | B1 | 8 flows in `suites/maestro` (`appId`, `launchApp: {clearState: false}`, `tapOn: {id}`, `inputText`, `assertVisible`, `extendedWaitUntil`, `openLink`, `runFlow` fragments for onboarding/sign-in, `retry`/`repeat` for the dropped-first-press cases); argv `maestro --udid … test suites/maestro --format junit --output … --test-output-dir … [--no-reinstall-driver on warm reps]`; parses junit + `commands.json`; `doctor` checks `maestro --version`, Java. |
| WDN-BENCH-A3 | ✨ feat(bench): argent adapter + suite | B1 | 8 e2e flows in `suites/argent` (`launch:`, `tap: {id}`, `type: {…, submit:false}`, `await: {visible}`, `await: {idle:true}` after navigations, `assert: {text}`, `tool: open-url` for the deep link, `when:` for the alert); argv `argent flow run suites/argent --device … --platform … --json`; parses the JSON aggregate (steps + ms); prepare = `argent server start`, teardown = `argent server stop` + kill `simulator-server`/`ax-service`. |
| WDN-BENCH-A4 | ✨ feat(bench): agent-device adapter + suite | B1 | 8 `.ad` scripts (`agent-device help replay` / `help test` for syntax; `open <bundle> --relaunch`, `press id="…" --settle`, `fill`, `wait 'id=…' ms`, `is`, `open <deeplink>`, `close`); argv `agent-device test 'suites/agent-device/*.ad' --platform … --udid\|--serial … --reporter junit:… --artifacts-dir … --verbose --retries 0`; parses junit + `replay-timing.ndjson`; prepare = `agent-device prepare ios-runner` (cold measured), teardown = `daemon stop --clean`. |
| WDN-BENCH-A5 | ✨ feat(bench): tester.army adapter + suite | B1 | `suites/tester-army` from `git show b43e121:apps/example/e2e/…` (8 tests, locator-only, no `agent.*`), `e2e.config.ts` with `mobile({platform, device: udid\|serial, session: "bench-<udid>"})` + `app.bundleId`; devDeps `e2e`, `@e2e-dev/mobile` pinned; argv `e2e run --reporter list,json,junit --output <dir>` with the Node PATH fix (Decision 10); parses `report.json`; teardown = `agent-device daemon stop --clean` (its bundled agent-device). |
| WDN-BENCH-A6 | ✨ feat(bench): detox adapter + suite (best-effort) | B1 | `suites/detox/.detoxrc.ts` (`apps.ios.release.binaryPath` = ctx.appPath, `devices.simulator.device.id` = udid, `behavior.init.reinstallApp: false`, `session.debugSynchronization: 0`), `jest.config.js` (`detox/runners/jest`), 8 specs (`by.id`, `device.launchApp({newInstance:true})`, `device.openURL`); argv `detox test -c ios.sim.release --retries 0 --json --outputFile …`; parses jest json; `doctor` requires `applesimutils`; any attach/sync failure → `status: "unsupported", reason`. Android: `unsupported` unless B8b. |
| WDN-BENCH-A6b | ✨ feat(bench): detox android (optional, flag) | A6 | Behind `BENCH_DETOX_ANDROID=1`: documents the `@config-plugins/detox` + `detox build` path and a separate instrumented APK (fairness note in the report); not run by default. |

### Report (R)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-BENCH-R1 | ✨ feat(bench): markdown report + compare | B1 | `report/markdown.ts`: header (host, device, app hash, fairness rules, versions), framework summary table (suite median/p95, cold-start, teardown, pass rate, residue, footprint), per-test matrix (median ms per framework + ratio to fastest, bold fastest), per-step table where available, unsupported/failed sections with reasons; `compare.ts` diffs two `bench-results.json`; golden-file tests. |
| WDN-BENCH-R2 | ✨ feat(bench): static HTML report | R1 | `report/html.ts` + `svg.ts`: one self-contained `report.html` with inline JSON, grouped bar chart (suite wall per framework), per-test grouped bars, box/whisker per test from warm reps, step-latency strip chart, resource timeline; light/dark via `prefers-color-scheme`; no external assets; tests snapshot the SVG structure. Load the `dataviz` skill before writing chart code. |

### Verification + docs (V)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-BENCH-V1 | ✅ test(bench): iOS end-to-end run | H3,A1–A6,R2 | `bun run bench run --platform ios --runs 3` on a leased sim completes; every framework `ok` or `unsupported` with a reason; `report.md`/`report.html` written; residue section empty after teardown; results committed as `docs/bench/ios-<date>.md` (markdown only). |
| WDN-BENCH-V2 | ✅ test(bench): Android end-to-end run | V1 | Same on an emulator (`warden claim android`); selector gaps fixed in suites (resource-id vs testID); results in `docs/bench/android-<date>.md`. |
| WDN-BENCH-V3 | 📝 docs(bench): AGENTS/README/docs site | V1 | `packages/e2e-bench/AGENTS.md` (+ `CLAUDE.md` pointer), root `AGENTS.md` directory table + README section, `apps/docs/content/docs/guides/bench.mdx` (how to run, read, add a framework/test), memory note. |
| WDN-BENCH-V4 | ✨ feat(docs): framework comparison page | V1, V2 | A docs-site page (`apps/docs/content/docs/comparison.mdx` or similar, linked from the nav) that shows off the benchmark results: the summary table and per-test matrix from `docs/bench/ios-<date>.md` / `android-<date>.md`, charts (reuse `report/svg.ts` output or static SVGs), the fairness rules and versions, and a link to the full HTML reports. User request 2026-10-16. |

## Implementation team (child worktree; waves)

| Wave | Issues | Gate |
|---|---|---|
| 0 | B0, B1 | package builds; `bun run typecheck && bun run check && bun run test` green at root |
| 1 (parallel, 9 agents) | H1, H2, A1, A2, A3, A4, A5, A6, R1 | each with colocated tests on fixtures; adapters runnable by hand with `--udid` against a leased sim |
| 2 (parallel, 2) | H3, R2 | `bench run --frameworks warden --runs 1` works end to end |
| 3 | V1 → V2 → V3 (+ A6b if wanted) | reports committed; PR to `feature/faster-local-e2e-runner` |

Handoff prompt for the child agent (B0): read this plan, `packages/e2e/AGENTS.md`, `apps/example/AGENTS.md`, `scripts/smoke/ui-bench.ts`, memory notes `warden-subagent-devices`, `e2e-node-version`, `warden-e2e-local-verification`; run waves with 5–15 subagents; never `warden release --mine`; keep the Mac awake for device runs; update the Orca worktree comment at each gate.

## Verification

1. Unit: `bun run --cwd packages/e2e-bench test` (parsers on fixture outputs from each framework, stats, report golden files, isolation/exec with fake exec).
2. `bench doctor` lists all six frameworks with versions and the install hints for anything missing (`applesimutils`, Node 24 path).
3. `bench run --platform ios --frameworks warden,maestro --runs 2 --udid <leased>` by hand first, then the full `--runs 3` run (V1), then Android (V2).
4. Inspect `report.html` in a browser (chrome-devtools MCP or `open`), `report.md` in the PR.
5. Residue: after the run `pgrep -fl 'warden-simd|simulator-server|agent-device|maestro|detox'` is empty and `xcrun simctl listapps <udid>` has no driver runners (unless `--keep-drivers`).

## Risks

- Detox on RN 0.86: Fabric idling resources may crash/hang (issue #4963 on 0.85); adapter must time out (`--job-timeout`) and report `unsupported`.
- Maestro flow semantics (built-in waits, `clearState`) differ; per-step `duration` includes its own polling — report steps as-is, compare per-test totals primarily.
- Argent `flow run` on Android emulators: `--device <serial>`; verify the flow `launch:` map (`native:` id) works on both platforms.
- agent-device/tester.army share a daemon design; tester.army bundles its own agent-device 0.21.25 while the global is 0.21.20 — record both versions; ensure `daemon stop --clean` kills both.
- Android: testID exposure differs (resource-id vs `tag`); first Android run will need selector fixes per framework (V2 budget).
- Device time: a full iOS run ≈ 6 frameworks × 3 reps × ~2–4 min ≈ 1–1.5 h; keep the Mac awake (`caffeinate`), run on a dedicated sim.

## Resolved questions (user, 2026-10-16)

1. Detox: best-effort (`unsupported` on failure). 2. Report: Markdown + static HTML. 3. Platforms: iOS + Android. 4. Execution: hand off to a Claude agent in the child worktree.

## Status

2026-10-24: Maestro and Detox removed (WDN-CPU 1): Maestro's suite never passed and Detox cannot attach to RN 0.86.
