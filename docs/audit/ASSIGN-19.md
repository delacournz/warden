# Assignment 19 · `bench-and-suites` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/19-bench-and-suites.md` and `docs/audit/raw/19-bench-and-suites.jsonl`.

## Improvement goal

Measurement fidelity of the benchmark harness (sampler, isolation, residue, untraced-time calculation, stats), and suite-side waste in the example/bench flows and the `warden ui bench` targets. The audit's other agents rely on the bench numbers: say where they can mislead.

## Owned files

- `packages/e2e-bench/src/{cli,args,orchestrator}.ts` and tests (`orchestrator.test.ts` 417)
- `packages/e2e-bench/src/adapters/{warden,adapter.types,registry}.ts`, `src/adapters/parse/warden-results.ts` and tests + `fixtures/warden/**` (the other five adapters are not audited)
- `packages/e2e-bench/src/harness/{exec,device,app,phases,sampler,residue,isolation,host,anr}.ts` and tests + `harness/fixtures/**`
- `packages/e2e-bench/src/results/{schema,stats,manifest,footprint,write}.ts` and tests
- `packages/e2e-bench/src/report/{summary,tables,compare,format}.ts` and tests (the html/svg/markdown renderers are not audited)
- `packages/e2e-bench/suites/warden/**` (`*.e2e.ts`, `helpers/{flows,ids}.ts`, `flows.test.ts`) — byte-identical copies live in `apps/example/e2e/**`: read one copy, note any divergence
- `apps/cli/src/agent-ui/bench.ts` and `bench.test.ts`, `scripts/smoke/ui-bench.ts` and test
- Read-only context: `packages/e2e-bench/AGENTS.md`; `docs/plans/wdn-bench.md` § Architecture (sampler and isolation design) and § Risks; `docs/plans/wdn-perf.md` PERF-6.1, PERF-6.3 and the Follow-ups rows for referee and lead (K2, K11, K13); both `docs/bench/*-2026-10-16-perf.md` "Read with care" sections.

## Starting hotspots

- `sampler.ts` (310): `ps -axo pid,ppid,rss,%cpu,comm` every 500 ms, process-tree walk from the spawned pid + `residuePatterns`, pid + start-time tracking, Android `top -n 1 -b` every 2 s and the helper regex; RSS summed per process (shared pages counted per process, as the report says); no per-process split (K2): what a split costs and what it would attribute (bun test process vs `warden-simd` vs others). Does the sampler's own `ps` load show up in host CPU?
- `isolation.ts` (267): helper stop before other frameworks (K11 cold prepare 708 ms), daemon kills, cold uninstall, optional reboot, Android animation-scale reset: ordering gaps that could leave a stream open (the one-helper-per-sim rule) or leak residue to the next framework.
- `warden-results.ts` (114): `untracedMs` = test wall − union of steps and spans (nested count once): correctness of the interval union, what the idiomatic suite's 0.27 s/0.11 s residue consists of (K1), and whether `trace.jsonl` `ts` = start time ordering is handled.
- `stats.ts` / `summary.ts`: medians over warm reps, p95 with n = 2 or 3 reps (what p95 means at n=3), `ratioToFastest`, `coldStartMs` definition, `flakeRate`; `compare.ts` 5 % regression guard.
- `orchestrator.ts` (583): phases timing, `bench-results.json` written after every framework, SIGINT release of exactly the claimed lease ids, `caffeinate`, load-average abort rule (`--force`).
- `device.ts` / `app.ts`: spawns of `apps/cli/src/cli.ts` (bun start per call) during a run: are any inside a timed window?
- Suites: `helpers/flows.ts` (107) fixed waits (`expectTodosAfterSignIn` 15 s cap, 3 deep links of 6 s, `tap({until})` 4 s + two re-sends), `test.use({ systemAlerts })`, `launch` per test: which waits are structural retries for app behaviour (dropped first press) vs headroom that inflates the warm medians; parity rule with the other frameworks (`AGENTS.md`).
- `bench.ts` (332) / `ui-bench.ts`: `BENCH_TARGETS` vs measured (`snapshotWarm` p50 < 60 missed at 64–106 ms on a loaded host; `helperColdToSnapshot` < 1500), `BENCH_TOLERANCE` 1.5, `percentile` implementation reuse.
- K13: find the test that failed once under load and its timing assumption.
