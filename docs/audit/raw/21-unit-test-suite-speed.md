# 21 unit-test-suite-speed

Absolute wall times come from `00-baseline-tests.txt` (serial, quiet container). My runs were taken in the same container, serially, after the other auditors had finished. Verifier agents may have run a single file at the same time, so use my numbers for the relative ranking of files and for before/after comparisons within my own runs, not as absolutes. Per-file times come from `bun test --reporter=junit` (`time` on each `<testsuite file=…>`). Machine: 4 cores, Bun 1.4.2.

| package | baseline wall | my serial wall | my `--parallel=4` wall | slowest 5 files (s, my run) |
|---|---|---|---|---|
| apps/cli (1322 tests, 109 files) | 57.8 s | 55.9 s | 34.5 s and 37.2 s (two runs, same 9 failures) | `commands/e2e.test.ts` 22.8; `npm/declarations.test.ts` 6.3; `agent-ui/helper.integration.test.ts` 4.8; `npm/config-entry.test.ts` 3.6; `commands/batch.test.ts` 2.7 |
| packages/core (651 tests, 52 files) | 15.3 s | 15.0 s | 7.9 s | `affected/graph-process.test.ts` 6.2; `affected/affected.test.ts` 3.2; `affected/graph-snapshot.test.ts` 1.4; `affected/git.test.ts` 0.8; `affected/graph-worker.test.ts` 0.6 |
| packages/e2e (1792 tests, 96 files) | 9.7 s | 9.3 s | 3.3 s | `runner/runner.test.ts` 2.1; `driver/ios/simd-client.test.ts` 1.8; `devtools/collector.test.ts` 1.4; `driver/android/adb-session.test.ts` 1.0; `driver/android/uiad-client.test.ts` 0.4 |
| packages/e2e-bench (355 tests, 37 files via `bun test src suites/warden/helpers`) | 5.6 s | 5.7 s (unscoped run, see 21-12) | not run | `harness/exec.test.ts` 5.0 (timeout wait); `orchestrator.test.ts` 0.2; everything else under 0.03 |

The 15 slowest files across the repo (my serial run):

| # | file | s | why |
|---|---|---|---|
| 1 | apps/cli/src/commands/e2e.test.ts | 22.8 | 96 tests, each builds a git repo twice (21-1) |
| 2 | apps/cli/src/npm/declarations.test.ts | 6.3 | two identical full-program `emitDeclarations` of packages/e2e (21-3) |
| 3 | packages/core/src/affected/graph-process.test.ts | 6.2 | real `bun graph-worker.ts` child per case, loads TypeScript each time (inherent; see 21-10) |
| 4 | packages/e2e-bench/src/harness/exec.test.ts | 5.0 | `realExec` timeout test waits for `sleep 5` (21-6) |
| 5 | apps/cli/src/agent-ui/helper.integration.test.ts | 4.8 | real `SHUTDOWN_WAIT_MS` 2 s and `SIGNAL_WAIT_MS` 1.5 s waits (21-8, 21-9) |
| 6 | apps/cli/src/npm/config-entry.test.ts | 3.6 | `ts.createProgram` per assertion (3 programs, 1.4 + 0.9 s + beforeAll build) |
| 7 | packages/core/src/affected/affected.test.ts | 3.2 | `computeAffected` through the real worker and real git |
| 8 | apps/cli/src/commands/batch.test.ts | 2.7 | one 2.0 s case (fingerprint/install across several devices) |
| 9 | apps/cli/src/commands/affected.test.ts | 2.2 | `makeSuiteRepo` per test (6 tests, 0.4 s each) |
| 10 | apps/cli/src/commands/ui-flows.test.ts | 2.1 | one 1.7 s `ts.createProgram` typecheck of an exported spec |
| 11 | packages/e2e/src/runner/runner.test.ts | 2.1 | spawns `bun test` over real spec fixtures; 0.68 s deadline case |
| 12 | apps/cli/src/startup.test.ts | 1.9 | 16 `bun cli.ts` child processes, serial, about 0.1 s each |
| 13 | apps/cli/src/update/source-build.test.ts | 1.8 | a real bytecode build |
| 14 | packages/e2e/src/driver/ios/simd-client.test.ts | 1.8 | fake helper child processes, 0.5 s close-grace case |
| 15 | packages/e2e/src/devtools/collector.test.ts | 1.4 | real idle windows (0.68 s + 0.35 s) |

Real-time waits (step 3): about 100 `Bun.sleep` / `setTimeout` / `new Promise` hits in tests. Almost all are 1-100 ms polls (`waitFor` loops, `Bun.sleep(5)` yields) or injected fake clocks (`host.clock`, `uiad.testing.ts`, `poll.testing.ts`), which are fine. The exceptions are in 21-6, 21-8, 21-9. Nothing in a test needs `--timeout`: `apps/cli` runs 20 s and no test comes within 5x of it.

## Top 5 by impact

1. 21-1 `commands/e2e.test.ts` rebuilds a git repo twice per test: about 13-18 s of the 22.8 s file, and it is the critical path of the cli suite.
2. 21-2 No package runs `bun test --parallel`: measured cli 55.9 -> 34.5 s, core 15.0 -> 7.9 s, e2e 9.3 -> 3.3 s with identical results.
3. 21-4 All 8 cli port failures and the core `isPortFree` failure are one root cause (18-2), plus the cascade into `port release`.
4. 21-7 Unit tests run only on macOS in CI, so Linux-only failures (21-4, 21-5, 21-6) are invisible.
5. 21-8 Wall-clock assertions with thin margins (`ui close` < 2.5 s against a 2 s real wait) will flake on a loaded runner, and more so once tests run in parallel.

## Findings

### 21-1 `commands/e2e.test.ts` builds a fresh git repo twice per test (`beforeEach` plus `resuite`)
- Category: test-gap
- Severity: P1
- Known?: new
- Evidence:
  - `apps/cli/src/commands/e2e.test.ts:20-22` `beforeEach` calls `makeSuiteRepo(FLOW_ISOLATION)`. `e2e.test.ts:29-32` (`resuite`) and `:35-38` (`resuiteDefault`) `rmSync` that repo and call `makeSuiteRepo` again; `grep -c "await resuite(\|await resuiteDefault("` gives 72 calls in 96 tests, so 168 repos are built per run.
  - `packages/core/src/affected/fixture.testing.ts:52-96` writes about 25 files and runs six real `git` processes (`init`, `config` ×2, `add .`, `commit`, `checkout -b`). A PATH shim logging every `git` argv shows 18 git spawns for one test that calls `resuite` (12 from the two fixtures, 6 from the command under test), and 1310 spawns for the whole file.
  - Measured in the container: `makeSuiteRepo()` + `rmSync` averages 137 ms (20 iterations). 168 × 137 ms = 23 s, which is the same size as the whole file (22.75 s, 96 cases, mean 0.24 s). The remaining cost is the actual `changedFiles` and `snapshotKey` git calls in the command (about 6 per test, 1.7 ms each for `rev-parse`).
  - Many tests are therefore flat at about 0.3 s regardless of what they assert (`junit` shows 0.30-0.39 s for a dozen unrelated cases).
  - `commands/affected.test.ts:13` repeats the pattern (6 tests, 0.39-0.44 s each, 2.2 s).
- Impact: estimated 13-18 s saved of the 22.8 s file, i.e. of the 55.9 s serial cli run. The file is also the critical path under `--parallel` (34.5 s wall against 22.8 s for this file alone), so the parallel wall falls toward about 20 s as well. Host-side only; applies to every `bun run test` on every platform.
- Proposed fix: build the repo once per distinct (suite overrides, config) in a `beforeAll`/memo and give each test a copy: `cpSync(template, dir, {recursive:true, verbatimSymlinks:true})`, then re-point the one absolute `node_modules/@x/ui` symlink with `symlinkSync`. A git repo copied that way is valid (no absolute paths inside `.git` except the optional worktree files). For `resuite`, only `warden.config.json` differs, so rewrite that file and leave HEAD alone (the tests only diff against `main`). Touch `fixture.testing.ts` (add a `cloneSuiteRepo`) and `e2e.test.ts`/`affected.test.ts`. Additive, tests only.
- Effort: S
- Risk: low. A test that mutates the repo must not share it, hence a copy per test, not one repo for the file. No device needed.
- How to verify: `bun test src/commands/e2e.test.ts` before/after (22.8 s today), and `grep` the git shim log for the spawn count (1310 today).
- Confidence: high on the mechanism, med on the exact saving (copy cost not measured)
- Verified by: ran `bun test src/commands/e2e.test.ts` with a git shim and a timing harness for `makeSuiteRepo`; read `fixture.testing.ts` and the test file.

### 21-2 None of the packages run `bun test --parallel`; the cli suite is serial at 56 s
- Category: dx
- Severity: P1
- Known?: new
- Evidence:
  - `apps/cli/package.json` test script is `bun test --timeout 20000`; core and e2e are plain `bun test` (`packages/*/package.json`). The root `test` is `turbo test` (`package.json:15`), which already runs the four packages side by side, so the root wall is the longest package (cli).
  - Bun 1.4.2 offers `--parallel[=N]` (worker processes, implies `--isolate`), `--timings` and `--shard` (`bun test --help`).
  - Measured here (4 cores): cli serial 55.9 s, `--parallel=4` 34.5 s and 37.2 s (two runs); core 15.0 -> 7.9 s; e2e 9.3 -> 3.3 s. Pass/fail counts were identical (cli the same 9 failures from 21-4/21-5, core the same 1, e2e 0). The cli floor is `commands/e2e.test.ts` (22.8 s, see 21-1).
  - Tests were written for isolation already: temp `WARDEN_HOME`, injected side effects (`AGENTS.md`). No fixed port numbers are bound in `*.test.ts` (the `FROM = 47xxx` values only seed the injected allocator).
- Impact: measured, cli 55.9 -> about 35 s (-21 s), core -7 s, e2e -6 s per package serial wall. On the 4-core mac runner a smaller gain is likely; repeat there.
- Proposed fix: change the three scripts to `bun test --parallel` (cli keeps `--timeout 20000`); optionally `--timings` with a committed durations file so the 22 s file starts first. Do it after 21-8 so wall-clock assertions do not flake under the extra load. Additive.
- Effort: S
- Risk: med. Parallel workers share CPU, so every timing assertion in 21-8 gets less headroom, and `lock.race-fixture`/`store.race-fixture` tests that spawn processes compete for cores. Two parallel cli runs here were stable. Verify with 5 repeat runs on the CI runner.
- How to verify: `for i in 1 2 3 4 5; do bun test --parallel; done` on the CI image, all green; compare wall.
- Confidence: high
- Verified by: ran the three packages with and without `--parallel`.

### 21-3 `declarations.test.ts` emits the same declarations twice (6.3 s)
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence: `apps/cli/src/npm/declarations.test.ts:48-62` and `:64-83` each call `emitDeclarations` with identical arguments (tsconfig `packages/e2e/tsconfig.json`, same two entries, same `packagesDir`); only `outDir` differs, via `beforeEach` (`:35-38`). Each call builds a full TypeScript program: 3.41 s and 2.92 s in the junit output.
- Impact: estimated 2.9-3.4 s saved of cli serial wall (one emit instead of two), on the 6.3 s file. It is the second largest file in the cli suite.
- Proposed fix: emit once in `beforeAll` into one `out` dir, run both assertion blocks against it (`afterAll` removes it). Tests only; additive.
- Effort: S
- Risk: low. Test isolation is not needed: both tests only read the output.
- How to verify: `bun test src/npm/declarations.test.ts` drops from about 6.3 s to about 3.4 s.
- Confidence: high
- Verified by: read; ran the file via the full cli run.

### 21-4 One root cause (18-2) fails 8 cli tests and 1 core test; `port release` "invalid port NaN" is a cascade
- Category: test-gap
- Severity: P1
- Known?: new (the product cause is auditor 18's finding 18-2, `18-core-store-affected.md`, cited not re-derived)
- Evidence:
  - core: `ports.test.ts:203` (18-2).
  - cli `port claim` ×5: `commands/port.test.ts` claims through `claimPorts`, which fails with "no free port" on a host without IPv6 (`isPortFree` treats the code-less `::` bind error as busy, 18-2). The five claim tests assert exit 0 and get 1.
  - cli `port release` ×3: each test first runs `run(["claim", …])` and reads the port from its stdout. With the claim failing, stdout is empty, so `port.test.ts:103` is `Number(undefined)` = `NaN` and the command prints `invalid port "NaN"` (reproduced: `bun test src/commands/port.test.ts -t release`: test 1 at `:108` receives that message instead of `47399`; tests 2 and 3 at `:121` and `:130` read `c.db.listLeases()[0]` as undefined, pass `""` as a lease id, and get exit 1). None of the three failures is a release bug.
- Impact: 9 of the 11 baseline failures; fixed by one change in `ports.ts` (18-2). On macOS CI all nine pass.
- Proposed fix: fix 18-2; additionally have the release tests seed their leases with `c.db.insertLease` (as `:104` already does for the other owner) instead of going through `claim`, so a claim regression cannot masquerade as a release failure. Tests only for the second half.
- Effort: S
- Risk: low
- How to verify: `bun test src/commands/port.test.ts packages/core/src/ports.test.ts` on a host without `/proc/net/if_inet6`.
- Confidence: high
- Verified by: ran `bun test src/commands/port.test.ts -t release`, read `port.test.ts:98-131`, cross-read 18-2.

### 21-5 `doctor` "everything installed → all ok" is macOS-only but is not marked so
- Category: test-gap
- Severity: P2
- Known?: new
- Evidence:
  - `apps/cli/src/commands/doctor.test.ts:79-88` expects a `sim-helper` row whose detail contains the helper path (`:87`).
  - `apps/cli/src/commands/doctor-helper.ts:219-220` returns no rows at all when `deps.platform !== "darwin"` (`deps.platform` defaults to `process.platform`, `doctor.ts:83`: "Linux has no iOS, so it gets no rows"). On Linux `byName(c)["sim-helper"]` is undefined, `.detail` is undefined, and `toContain` throws "Received value must be an array type, or both received and expected values must be strings" (reproduced, `-t "everything installed"`). The two earlier assertions (exit 0, no non-ok rows) pass.
- Impact: 1 of the 11 baseline failures, a pure test/host mismatch, not a product bug. It will also fail for any contributor on Linux.
- Proposed fix: inject `platform: "darwin"` and `arch` through the doctor deps in this test (the file already has `HelperDeps`), or `test.skipIf(process.platform !== "darwin")`. Prefer the injection so Linux CI exercises the path. Tests only.
- Effort: S
- Risk: low
- How to verify: `bun test src/commands/doctor.test.ts` on Linux.
- Confidence: high
- Verified by: ran the single test; read `doctor.test.ts:79-88` and `doctor-helper.ts:210-221`.

### 21-6 `realExec` timeout test fails on dash, exposing a real gap: a timeout does not bound the call when a descendant holds the pipes
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `packages/e2e-bench/src/harness/exec.test.ts:17-20` runs `sh -c "sleep 5"` with `timeoutMs: 100` and expects `timedOut`. In this container `/bin/sh` is dash and does not exec the last command: `ps` shows `sleep` as a child of the `sh -c` process. On macOS `sh` (bash) execs it, so the kill lands on `sleep` itself.
  - `packages/e2e-bench/src/harness/exec.ts:114-120` sends SIGTERM to `proc` (the shell) only; `exec.ts:121-125` then awaits `drain(stdout)`, `drain(stderr)` and `proc.exited`. The orphaned `sleep 5` still has the pipe write ends open, so the drains finish only when it exits at about 5 s. The call returns after 5000.13 ms, exactly the default 5 s test timeout, so the case is reported as failed at `[5000.13ms]`. `KILL_GRACE_MS` (`exec.ts:47`, 5 s) never helps because the shell is already dead.
  - Real effect: any adapter command that forks (a `sh -c "npx maestro …"` wrapper, Detox, `xcodebuild`) can run past its `timeoutMs` until its children finish.
- Impact: 1 baseline failure on Linux; in the benchmark, a hung child makes `timeoutMs` ineffective. Not on the unit-test hot path otherwise (this test is also the slowest case in the package: 5.0 s of 5.7 s).
- Proposed fix: in `exec.ts`, start children in their own process group (`detached`/`setsid`) and signal `-pid`, or stop awaiting the drains once the timer has fired and the process has exited (cancel the readers). In the test, use `exec sleep 5` so it is host independent, and lower the sleep to 2 s. `packages/e2e-bench` only; additive.
- Effort: S
- Risk: low. Needs no device. Process-group kill must not signal the parent group.
- How to verify: `bun test src/harness/exec.test.ts` on Linux: the timeout case finishes in about 150 ms.
- Confidence: high on the mechanism (ps output, timing match), med on the best fix shape
- Verified by: ran `bun test` in `packages/e2e-bench` (fail at 5000 ms) and checked `ps` for a dash `sh -c 'sleep 5'`.

### 21-7 Unit tests run only on macOS in CI, so every Linux-only failure above is invisible
- Category: dx
- Severity: P2
- Known?: new
- Evidence: `.github/workflows/ci.yml:64` (`runs-on: namespace-profile-mac-small`) is the only job that runs `bun run test` (`ci.yml:81-83`); the other jobs (`:89` linux-small, `:118` `macos-latest`) do not. The baseline shows 11 failures on Linux (21-4, 21-5, 21-6), all green on macOS (PR 31).
- Impact: a contributor or an agent in a Linux container (which is where this repo's agent sessions run) sees 11 red tests that CI never reports, and real Linux regressions (the `ci` owner kind exists for Linux runners, see 18-2) ship unnoticed. Also macOS runners are the scarce, slower resource for what is host-independent unit work.
- Proposed fix: after 21-4/21-5/21-6, add `bun run test` to a Linux job (or move the unit tests there and keep macOS for swift/native). Additive (CI only).
- Effort: S
- Risk: low. The first Linux run may surface more host assumptions.
- How to verify: the Linux job is green on the PR.
- Confidence: high
- Verified by: read `ci.yml`.

### 21-8 Wall-clock assertions with thin margins (flake risk on loaded CI and under `--parallel`)
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence (all assert elapsed real time):
  - `apps/cli/src/agent-ui/helper.integration.test.ts:142`: `ui close` must finish in < 2500 ms, but its fallback legitimately waits `SHUTDOWN_WAIT_MS = 2000` (`agent-ui/helper.ts:31`) before SIGTERM. The case took 2.10 s here, so the headroom is about 0.4 s. A busy runner (spawn of a fake helper, sqlite, SIGTERM) can exceed it.
  - `helper.integration.test.ts:126` (< 1500 ms for `stopHelper`), `:297` (< 4000 ms against `SIGNAL_WAIT_MS` 1.5 s + poll).
  - `apps/cli/src/batch/stamped-log.test.ts:99`: "done at once" asserts < `quietMs` = 40 ms on `performance.now()`.
  - `apps/cli/src/commands/batch.test.ts:449`: < 1500 ms around a `sh -c "sleep 30 & …"` spawn (also leaves a `sleep 30` behind if the kill path regresses).
  - `packages/e2e/src/devtools/session.test.ts:171` (< 2000 ms reconnect), `devtools/tree.script.test.ts:404` (< 500 ms with a 30 ms guard), `driver/ios/simd-client.test.ts:315` (< 3000 ms with 300 ms grace), `runner/runner.test.ts:149` (< 5000 ms).
  - `packages/e2e/src/screen/poll.test.ts:178-180` and `ui-collect.test.ts:44` (`Bun.sleep(100)`) are benign.
  - Fake-clock assertions (`locator.test.ts:411`, `android-device.test.ts:101`, `locator.react.test.ts:187` using `host.clock.elapsed()`) are deterministic and fine. K13 (one bench test failing once under load) is the same class.
- Impact: not measurable here; the risk grows when 21-2 makes tests share CPU. The worst case is a red PR gate that passes on retry.
- Proposed fix: assert behaviour, not time: pass the wait constants as injectable options (21-9) so the tests use 20-50 ms waits and assert on the outcome (`how: "sigterm"`, socket gone). Where a bound is kept, make it at least 5x the nominal value (stamped-log: bound by `quietMs * 5`, or assert that no timer was armed). Tests plus small option plumbing in `helper.ts`; additive.
- Effort: M
- Risk: low
- How to verify: run the listed files 20× under `taskset -c 0` or alongside a `yes > /dev/null` per core; none should fail.
- Confidence: med (margins are measured only for the `ui close` case)
- Verified by: read; ran the cli suite (`ui close` 2.10 s).

### 21-9 `helper.integration.test.ts` burns about 3.4 s of real waiting on constants it cannot inject
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence: the case "`warden ui close` finishes within 2.5 s even when the helper ignores shutdown" took 2.10 s, "a helper that prints nothing still starts" 1.61 s (`SIGNAL_WAIT_MS = 1500`, `agent-ui/helper.ts:42`), and "concurrent ensureHelper from several processes" 0.76 s. The file totals 4.77 s for 14 tests; `SPAWN_WAIT_MS`, `SHUTDOWN_WAIT_MS`, `SIGNAL_WAIT_MS`, `POLL_MS` are module constants (`helper.ts:29-42`).
- Impact: estimated 3.4 s of cli serial wall (2.1 + 1.6 s waits down to about 0.2 s), about 6 %.
- Proposed fix: add the timings to `HelperDeps` (defaulting to today's values) and shrink them in the two tests. Same edit as 21-8. Additive.
- Effort: S
- Risk: low. Production waits stay unchanged.
- How to verify: file wall drops to about 1.4 s; the production `ui close` fallback still takes 2 s (cover with the existing test using the default deps once, marked slow, or a unit test of the constant).
- Confidence: high
- Verified by: ran the cli suite; read `helper.ts:29-42` and the test.

### 21-10 `core/affected` tests spawn a real worker `bun` and load TypeScript per case (about 10 s of the 15 s core suite)
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `affected/graph-process.test.ts` 6.2 s (21 tests; five cases of 0.5-1.07 s), `affected.test.ts` 3.2 s (7 tests, 0.42-0.81 s), `graph-snapshot.test.ts` 1.4 s, `git.test.ts` 0.8 s, `graph-worker.test.ts` 0.6 s. Cost is `bun graph-worker.ts` + TypeScript load (about 400 ms cold, 18-4) and real `git` per case. Most of this is the point of the tests (the worker protocol), but several cases only need the in-process path (`bun: null` is supported, `graph-process.ts:55-56`).
- Impact: estimated 2-3 s of the 15 s core suite if only the 2-3 worker-protocol cases keep the real spawn.
- Proposed fix: default the other cases to `bun: null` (in-process, one TypeScript load per file) and keep one real-worker case plus the compiled-binary fallback case. Tests only.
- Effort: M
- Risk: low; coverage of the spawn path stays in the retained cases.
- How to verify: `bun test src/affected` before/after.
- Confidence: low (saving is a guess from per-case times)
- Verified by: read `graph-process.ts:55-56`; ran core.

### 21-11 `help.test.ts` snapshot is 85 KB across 31 entries
- Category: dx
- Severity: P3
- Known?: new
- Evidence: `apps/cli/src/__snapshots__/help.test.ts.snap` (85,108 bytes, 31 `exports[`); `batch/__snapshots__/tui.test.ts.snap` is 2 entries / 623 bytes. Any new flag, summary or alias rewrites one or more of the 31 blobs, and `bun test -u` is the only practical fix.
- Impact: review noise, not runtime (the file is fast). Churn rather than flake.
- Proposed fix: keep one snapshot for the top-level `--help` and replace the per-command blobs with targeted assertions (usage line, each flag name present, no unknown placeholders). Tests only.
- Effort: M
- Risk: low
- How to verify: `bun test src/help.test.ts`.
- Confidence: med
- Verified by: read file sizes and entry counts.

### 21-12 `bun test` run inside `packages/e2e-bench` picks up the Detox suite and fails 8 tests
- Category: dx
- Severity: P3
- Known?: new
- Evidence: the package script is scoped (`"test": "bun test src suites/warden/helpers"`, `packages/e2e-bench/package.json`) and gives 355 tests in 37 files. A bare `bun test` there also collects `suites/detox/*.test.js` (and the other suites' specs) and reports 363 tests across 42 files with 8 failures (`todos > add, complete and filter todos`, `sign-in > …`, …), because those need a device-side runner. I hit this on my first run; anyone following the AGENTS.md "run `bun test <path>`" rule from the package directory will too.
- Impact: false red locally; no CI effect.
- Proposed fix: add a `bunfig.toml` in `packages/e2e-bench` with `[test] root = "src"` or `pathIgnorePatterns`, so a bare `bun test` matches the script. Additive.
- Effort: S
- Risk: low
- How to verify: `cd packages/e2e-bench && bun test` reports 355 pass.
- Confidence: high
- Verified by: ran both forms.

## Child-process tests (step 4)

| file | spawns | serial time |
|---|---|---|
| `apps/cli/src/startup.test.ts` | 16 `bun cli.ts` children (plus one `bun script`, `true`) | 1.9 s |
| `apps/cli/src/agent-ui/helper.integration.test.ts` | one fake-simd per test (14), a race fixture with several processes | 4.8 s |
| `packages/core/src/{store,ports,builds/lock}.test.ts` with `*.race-fixture.ts` | 2-4 `bun` children per race case | 0.3 s, 0.5 s |
| `packages/core/src/affected/graph-*.test.ts` | one worker `bun` per walk | about 8 s (21-10) |
| `packages/e2e/src/runner/runner.test.ts`, `driver/ios/simd-client.test.ts`, `android/*` | `bun test` over spec fixtures; fake helper/adb children | 2.1, 1.8, 1.0 s |

All of them are serial inside one file. Nothing in these files is wasteful beyond 21-9 and 21-10. `startup.test.ts` is cheap (about 0.1 s per case) and is the right way to test lazy imports.

Shared setup (step 6): sqlite stores and temp dirs per test are cheap (core's other 600 tests sum to under 7 s). The only per-test setup that matters is the git repo in 21-1.

## Known items

- K13 (a bench test failed once under load): same class as 21-8; no new mechanism for the bench itself, and no bench suite was run here.

## Gaps I could not assess here

- Swift tests (`swift test --package-path packages/e2e/native/ios`) and the `warden-simd` helper are macOS-only; CI runs them in the `macos-latest` job (`ci.yml:118-152`). Nothing in `bun test` covers the real helper; `fake-simd.ts` stands in.
- Android: no emulator tests exist in `bun test`; `warden-uiad` is covered by fakes only (K6). Needs a device run.
- `declarations.test.ts`, `config-entry.test.ts` and `source-build.test.ts` depend on a real TypeScript/bytecode build; their timing on the mac runner is unknown.
- `--parallel` gain on the mac runner (21-2): run `bun test --parallel` there 5 times and compare with `bun run test`.
- The `doctor` helper rows (21-5) can only be meaningfully asserted on darwin without injection; the macOS CI job covers them today.

## Owned files not read

Most of the 297 test files were not read line by line; I read the ones named in the findings (`e2e.test.ts` head and fixtures, `declarations.test.ts`, `config-entry.test.ts`, `helper.integration.test.ts`, `port.test.ts`, `doctor.test.ts`, `exec.test.ts`, `startup.test.ts` greps) and grepped all of them for waits and elapsed-time assertions. `packages/types` tests were not run.

## Questions for the user

1. Is a Linux unit-test CI job acceptable (cost on the namespace linux profile), or must Linux stay out of CI? It decides whether 21-4/21-5/21-6 are fixed in the tests or skipped by platform.

## Files read

`docs/audit/BRIEF.md`, `docs/audit/ASSIGN-21.md`, `docs/audit/raw/00-baseline-tests.txt`, `docs/audit/raw/18-core-store-affected.md` (18-2), `apps/cli/src/commands/e2e.test.ts` (1-140 and greps), `apps/cli/src/commands/{port,doctor,affected,ui-flows}.test.ts` (parts), `apps/cli/src/commands/{doctor-helper,affected}.ts`, `apps/cli/src/npm/{declarations,config-entry}.test.ts`, `apps/cli/src/agent-ui/helper.integration.test.ts` (parts), `apps/cli/src/agent-ui/helper.ts` (constants), `apps/cli/src/startup.test.ts` (greps), `apps/cli/src/batch/stamped-log.test.ts`, `packages/core/src/affected/{fixture.testing,graph-process}.ts`, `packages/e2e-bench/src/harness/{exec,exec.test}.ts`, `packages/e2e/src/{devtools/session,devtools/tree.script,driver/ios/simd-client,screen/poll,screen/locator.react,runner/runner}.test.ts` (assertion lines), `.github/workflows/ci.yml`, package `package.json` test scripts, `bunfig.toml`.
