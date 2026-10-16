# Assignment 13 · `cli-e2e-observe` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/13-cli-e2e-observe.md` and `docs/audit/raw/13-cli-e2e-observe.jsonl`.

## Improvement goal

Lower the parent `warden e2e`/`batch` process's CPU and RSS while jobs run: the results poller, the TUI, log piping, and the verdict pass.

## Owned files

- In `apps/cli/src/commands/batch.ts` (1856), only these functions: `summaryJson`/`display` (~383–495), `readRunnerReport` (~541), `startView` … `announceDevices` (~554–587), `watchdog` (~641), the log/screenshot half of `jobRunner` (~677: output piping, drain, failure screenshot), `report` (~780). Read the rest to follow calls, but agent 12 owns it.
- `apps/cli/src/batch/{flow-poller,results-tail,runner-report,flow-progress,tui,stamped-log,stamp-lines,record,cast,serve,screenshot,results.testing}.ts` and tests (`tui.test.ts` with snapshots, `flow-poller.test.ts`, `results-tail.test.ts`, `flow-progress.test.ts`, `runner-report.test.ts`, `stamped-log.test.ts`, …)
- `apps/cli/src/e2e/verdicts.ts` (247) and `verdicts.test.ts`
- `apps/cli/scripts/bench-flow-poller.ts` (a micro-benchmark of the poller: read it, you may run it with `WARDEN_HOME` set)
- Read for the format only: `packages/e2e/src/runner/results.ts` (owned by 08)
- Read-only context: `docs/plans/wdn-perf.md` PERF-5.1; bench "host CPU avg 12.1 %" (K12; note the bench runs `bun test` directly, so the parent-process cost is NOT in that number).

## What a prior read found (verify every line)

- Poller: `setInterval` 1000 ms (`flow-poller.ts:85`), skips a tick while the previous look runs, loops unsettled files serially (`:75`); per file one `stat`, then `open`+`read` from a stored byte offset only when the file grew (`results-tail.ts:14-25,73-75`); each new line gets `JSON.parse` + zod `safeParse` (`:28-37`); `flowTracker` O(1) with memoised `realpath` (`flow-progress.ts:58-74`).
- After the run the same files are read whole in `readRunnerReport` (`batch.ts:548`), again in `verdicts.ts:92` (`readResults`, zod per line, cached per path `:87`), and again on a shard retry (`jobs.ts:81`).
- `flowOf` calls `realpathSync` per result × per flow, uncached (`flow-progress.ts:26-33`) from `runner-report.ts:28` and `verdicts.ts:127`; `verdicts.ts:129` copies an array per result.
- `stamped-log.ts`: `writeSync` per output chunk of every child on the supervisor thread (`:27,39`); drain loop `DRAIN_LOOK_MS` 10, `LOG_QUIET_MS` 250, `LOG_DRAIN_MS` 2000.
- TUI: `FRAME_MS` 1000 plus a redraw on every event (`batch.ts:224,460`); `summaryJson` built per frame?
- Failure screenshot awaited inline (`batch.ts:751`, `SCREENSHOT_TIMEOUT_MS` 5 s) holds up that worker's next job.

## Starting hotspots

- Quantify the parent's work per second with N workers: polls, stats, parses, frames, `writeSync` calls; where RSS goes (log buffers, retained results arrays, TUI frame strings).
- One parse per results line for the whole run (poller → report → verdicts share a cache) and a cached `realpath`.
- Event-driven redraw coalescing; `display` string building cost per frame at 1 Hz vs per event bursts.
- Log piping: `writeSync` vs a buffered writer; stamping per line vs per chunk; what `WARDEN_LOG_TIMESTAMPS=1` saves.
- `record.ts`/`cast.ts`/`serve.ts`/`screenshot.ts`: timeouts (10 s record start, 5 s screenshot) and any process left behind.
- `verdicts.ts`: exit-code fallback rules, `.only` gate, per-flow verdicts in single mode, the serial `for leg / for flow` loop cost.
- `tui.test.ts` snapshots: brittle to any change (DX finding if so).
