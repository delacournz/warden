# @delacour/warden-e2e-bench

Benchmarks six mobile e2e frameworks (warden, maestro, argent, agent-device, tester-army, detox) on the example app's 8-test parity suite (plan: `docs/plans/wdn-bench.md`; usage: `README.md`). Private, never published. No lease/build code here (that's `packages/core`); the suites drive the build `warden app ensure` produces.

## Layout

| Path | Purpose |
|---|---|
| `src/cli.ts` | `bench run \| doctor \| list \| report \| compare` (root: `bun run bench …`); SIGINT/SIGTERM abort cleanly |
| `src/args.ts` | flag parsing, `HELP` |
| `src/orchestrator.ts` | `runBench`: claim, `app ensure`, per framework doctor → prepare → reps → teardown → residue, `writeReports`; writes `bench-results.json` after every framework |
| `src/adapters/` | `adapter.types.ts` (`BenchAdapter`, `FRAMEWORK_IDS`, `RunContext`), `registry.ts` (`ADAPTERS`), one `<framework>.ts` each; `parse/` native reporter output → canonical `TestResult[]`; `fixtures/` real outputs |
| `src/harness/` | `exec.ts` (the only spawn seam, `fakeExec` for tests), `device.ts` (claim/release), `app.ts` (`warden app ensure`), `phases.ts` (timing, per-phase logs), `sampler.ts` (ps CPU/RSS, CPU-seconds from per-pid `ps time` deltas, host split by process group, per-rep `windowSummary`, Android `top` helper filter, pid + start-time tracking), `residue.ts`, `isolation.ts` (stop daemons/helpers, cold uninstall, reboot, Android animation-scale reset), `host.ts` (host facts, load average) |
| `src/results/` | `schema.ts` (zod, `bench-results.json` v1, `CANONICAL_IDS`), `stats.ts`, `manifest.ts` (loads `suites/manifest.json`), `footprint.ts`, `write.ts` (atomic write / read) |
| `src/report/` | `markdown.ts` (`FAIRNESS_RULES`), `html.ts` + `svg.ts` (self-contained), `compare.ts`, `tables.ts`, `format.ts` |
| `suites/<framework>/` | the 8 parity tests per framework; `suites/manifest.json` is the join key (canonical id ↔ native name + step labels) |
| `.bench/<run-id>/` | gitignored output: `bench-results.json`, `report.md`, `report.html`, `logs/`, `artifacts/<fw>/rep-<n>/` |

## Rules
- Never spawn in `bun test`: inject `Exec` (`fakeExec`). Never install global tools; `doctor` prints hints.
- Devices come from `warden claim --ttl 4h --label bench`, heartbeated every 60 s for the run; release exactly the lease ids claimed (never `--mine`). `--udid` reuses a lease and releases or heartbeats nothing: the caller must hold that lease.
- CPU headline = host CPU-seconds per rep (`RepResult.resources.cpuSeconds`: the timed `run` window only, warm median), from per-pid deltas of `ps time`. `ps %cpu` (`cpuAvgPct`/`cpuPeakPct`) is a decaying average on macOS and the framework-level `resources` are whole-framework (prepare … teardown): never judge a target on them.
- CPU-seconds bias (read before comparing frameworks): ticks see a process only while it is alive at a tick, so the CPU a process uses after its last tick, and processes that live entirely between two ticks, are missed. For every child the bench `run`s, the gap is closed at its exit: `ExecResult.cpuSec` (rusage, which includes the descendants it waited for) minus the last `ps time` of every process the ticks saw in its tree is charged as an `ExitCharge` at the exit time. Still missed: children the bench `start`s (daemons), processes a framework orphans or never waits for, and short-lived processes under pattern-matched daemons it did not spawn (a framework's own server), so a framework that fans out to many short `xcrun`/`adb` calls from such a daemon still reads low. Without a usable `time` column there are no CPU-seconds at all (absent, never 0; the sampler logs it once per framework).
- `ps time` resolution: macOS prints `M:SS.ss` (10 ms); procps (Linux hosts) prints `[DD-]HH:MM:SS`, whole seconds, so per-tick deltas on a Linux host are 0 or 1 s and only sums over many ticks (a rep, a framework) mean anything there. ps runs with `TZ=UTC LC_ALL=C` so `lstart` does not move with DST or the locale.
- Every suite must encode the same retries as `apps/example/e2e/helpers/flows.ts` (dropped first Next press, dropped first tab/row tap after sign-in, deep-link retry) so no framework gets an easier test. The warden suite writes them with warden's own options (`tap({ until })`, `app.open({ wait: "quiet" })`, `test.use({ systemAlerts })`, PERF-6.3: same 4 s window, two re-sends, 3 deep links of 6 s); the hand-rolled helpers that ran the published headline numbers are at `f05fee0`, and the other frameworks keep their own copies. Zero LLM, `retries=0`. Gaps a framework cannot express (argent checked state, agent-device retry) are documented in `README.md`, never papered over.
- A native test name missing from `suites/manifest.json` is a parity breach (framework `failed`, phase `run`); a manifest id absent from output is `missing`.
- Stop `warden-simd` before any other framework runs, and other daemons before warden (two AX clients on one sim collide).
- New framework or canonical test: update `adapter.types.ts` / `schema.ts`, `registry.ts`, `suites/manifest.json`, every `suites/<fw>/`, and the README + docs guide caveats. `bench doctor` fails a suite missing an id.
- tester-army needs Node `^22.22.3 || >=24.8`: `BENCH_NODE_BIN` / `--node-bin`. It keeps a private `AGENT_DEVICE_STATE_DIR` (`BENCH_TESTER_ARMY_STATE_DIR`).
- `Result` / `AsyncResult` from `@delacour/warden-types/result`; no `any`; no barrels; colocated tests; TDD.
- Report goldens live in `src/report/fixtures/` (helper `golden.ts`); regenerate with `UPDATE_GOLDEN=1 bun test src/report` and review the diff.
