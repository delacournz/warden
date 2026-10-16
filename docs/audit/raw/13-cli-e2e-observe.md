# Audit 13 · cli-e2e-observe

Scope: the parent `warden e2e` / `warden batch` process while jobs run (results poller, TUI, log piping, verdict pass). Commit `dfcc68b`. Micro-benchmarks below were run while ~20 other agents were running tests, so they are upper bounds, not clean timings. `WARDEN_HOME` was the scratchpad `home-13` on every `bun` run.

Headline: PERF-5.1 landed for the poller and the frame rate and both hold up. The parent's own steady-state work is small (about 3 ms of CPU per second of run with 8 workers, estimated below), so it is not where the iOS 12.1 % host CPU (K12) comes from. The findings are mostly robustness gaps in the observe path (frame timer and cursor on the error path, failure screenshot, recording start), plus one test-gap: nothing in the repo measures the parent.

## Top 5 by impact

1. 13-1 The TUI frame timer and hidden cursor are never cleaned up when `runGrid` throws (P2, robustness).
2. 13-2 The failure screenshot is awaited inline, duplicates the runner's `failure.png` and shows the end of the shard, not the failure (P2, perf-latency and correctness).
3. 13-3 `--record`: a recorder that exits early counts as started, a missing marker costs a flat 10 s before the first job, and a mid-run death is never noticed (P2, correctness).
4. 13-4 No bench or test measures the parent process; K12's 12.1 % does not include it (P2, test-gap).
5. 13-5 Every results line is parsed 3 times and `realpathSync` runs uncached per result × flow in the verdict pass (P3, perf-cpu; small today, grows as results × flows).

## Findings

### 13-1 The TUI frame timer and hidden cursor are never cleaned up when `runGrid` throws
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `display()` starts a `deps.every(FRAME_MS, …)` timer and keeps its stop in a closure (`apps/cli/src/commands/batch.ts:460`); the only caller of that stop is `end()` (`:488-491`), which also writes the final frame.
  - `runGrid` returns `{summary, screen}` and its `finally` stops only the poller (`:534-537`). `screen.end()` is called by `runSession` only on the success path, after `runGrid` returns (`:1438`). The `catch` at `:1461-1462` calls `fail(...)`, which prints the error with `reportError` (`:1376`), and `finally` then runs `teardown()` (`:1464`).
  - `liveScreen` hides the cursor on the first draw (`apps/cli/src/batch/tui.ts:360`, `\u001b[?25l`) and shows it only in `end` (`:368`).
  - Consequence if anything inside `runGrid` throws (`runPools`, `poller.poll()` via a throwing sink, `readRunnerReport`): the grid keeps repainting once a second with cursor-up and clear-to-end (`tui.ts:349`) over the error line, for the whole of `teardown()` (`stopServe` waits up to 15 s, `SERVE_KILL_GRACE_MS` at `batch.ts:219`) and `session.release()`. Then `process.exit` (`apps/cli/src/cli.ts:22`) leaves the terminal with the cursor hidden.
  - Not run: I have no TTY here. Read from the code only.
- Impact: no wall-time change. A terminal left with a hidden cursor and an error message overdrawn by the grid, on any internal error in the observe path. Platform: both.
- Proposed fix: make `Display.end` idempotent and call it from a `finally` in `runGrid` (or from the `catch` in `runSession`) before `fail()` prints. Optionally add `process.once("exit", () => terminal.write("\u001b[?25h"))` when the screen goes live. Files: `commands/batch.ts` (agent 12 owns `runGrid`/`runSession`), `batch/tui.ts` (`liveScreen.end` must tolerate a second call). Additive.
- Effort: S
- Risk: low. Only the error path changes. No device needed.
- How to verify: a `batch.test.ts` case with a fake `deps.every` that records stops and a `readFile` or `terminal.write` that throws on its third call. Assert the stop was called and the last write is `\u001b[?25h`.
- Confidence: high on the mechanism (the code path is unambiguous), med on how often it triggers.
- Verified by: traced path from `runGrid` (`batch.ts:503`) to `display().end` (`:488`) and `runSession` (`:1431-1464`).

### 13-2 The failure screenshot is awaited inline, duplicates the runner's `failure.png`, and shows the end of the shard
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `jobRunner.spawnOnce` does `if (code !== 0 && !o.interrupted()) await shoot(w, seq, log)` (`apps/cli/src/commands/batch.ts:751`) before returning the attempt's exit code. The worker's next job, which for a shard retry is the same device, cannot start until it returns. The cap is `SCREENSHOT_TIMEOUT_MS = 5_000` (`apps/cli/src/batch/screenshot.ts:7`, kill at `:54`).
  - iOS spawns `xcrun simctl io <udid> screenshot <path>` (`screenshot.ts:26`), which is an `xcrun` spawn plus `simctl`. Android spawns `adb exec-out screencap -p` (`:27`). The plan's own measurement of that Android route is 117 ms (`docs/plans/wdn-perf.md:449`). I found no iOS number in the plan or bench docs.
  - The spec runner already writes `failure.png` and `screen-at-failure.txt` from its open driver at each failed test (`packages/e2e/src/runner/failure.ts:7,31`, `packages/e2e/src/runner/attempt.ts:296`). The result line carries that directory (`artifacts.dir`, `packages/e2e/src/runner/results.ts:25`).
  - Under the default `isolate: "device"` (one `bun test` process per device, PERF-4.7, `wdn-perf.md:625` Decisions) the batch screenshot is taken after the whole shard process has exited. It shows where the device ended up after every later flow, not the state at the failing test, yet `e2e-report.json` presents it as "the device as the flow's last failed attempt left it" (`apps/cli/src/e2e/verdicts.ts:31-32`, `:65-74`).
  - The watchdog path also runs `shoot` before SIGTERM (`batch.ts:739-742`, `:649-651`), so a timed-out job lives up to 5 s past `--job-timeout`.
- Impact: estimated. Per failed attempt, 0.12 s on Android (measured screencap, see above) and 0.3 to 1 s on iOS (estimate: two process spawns plus a framebuffer encode; needs a device to measure), up to 5 s on a hung device. Zero on a green rep. It sits on the critical path of a retry, so it is only paid when something already failed.
- Proposed fix: when the attempt's `results.jsonl` has a failed test whose `artifacts.dir` holds `failure.png` (the e2e case), skip the batch screenshot and point `FlowVerdict.screenshot` at that file. Keep the batch shot for plain `warden batch` jobs and for attempts that left no results (crash, timeout), which is the case it is useful for. If it must stay, start it without awaiting only for jobs that are not retried on that worker; a retry relaunches the app and would overwrite the state. Files: `commands/batch.ts` (12), `e2e/verdicts.ts`, `commands/e2e.ts` (hook `screenshot: false` for e2e jobs). Changes the `e2e-report.json` `screenshot` path semantics, so contract: cli.
- Effort: S to M
- Risk: med. `e2e-report.json` consumers (skill docs, CI annotations) read `screenshot`. Needs a device only for the iOS timing.
- How to verify: unit test in `verdicts.test.ts` for a failed test with `artifacts.dir` and no batch shot. On device: time `captureScreenshot("ios", udid, path)` 20 times (`bun -e` calling `apps/cli/src/batch/screenshot.ts`).
- Confidence: med (iOS cost is unmeasured; the staleness argument follows from the code).
- Verified by: traced path from `spawnOnce` (`batch.ts:726`) through `shoot` (`:681`) to `captureScreenshot`, and from `lastFailure` (`verdicts.ts:62`) to the report.

### 13-3 `--record`: an early-exiting recorder counts as started, a missing marker costs 10 s, a mid-run death is never noticed
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - `startSimRecording` resolves with `startedAt` on any of three events: the text `recording started` on stderr, the end of stderr, or `proc.exited` (`apps/cli/src/batch/record.ts:25-42`). The last two resolve as success. A `simctl recordVideo` that fails at once (device not booted, bad codec) therefore returns a `Recording` as if it had started.
  - `startRecordings` accepts it and writes `video: dev-N.mp4` into `batch.json` (`apps/cli/src/commands/batch.ts:596-599`; `summaryJson` at `:405`), for a file that does not exist.
  - If the marker never appears (a changed Xcode message, or output buffering) the promise waits the full `START_TIMEOUT_MS = 10_000` (`record.ts:15,26`) and then assumes success. `startServices` awaits this before any job starts (`batch.ts:1190-1194`), so every `--record` run would start its jobs 10 s late, silently.
  - `stop()` returns `proc.exited` (`record.ts:46-51`) but `teardown` discards it (`batch.ts:1396`), so a recorder that died mid-run, or was killed after the 15 s SIGKILL (`STOP_TIMEOUT_MS`, `:16,48`, which leaves an unfinalised mp4), is not reported.
  - `record.ts` calls `Bun.spawn` directly, so none of this is unit-testable today (I did not read `record.test.ts`; it can only cover what `Bun.spawn` hides).
- Impact: correctness of `--record` (iOS only). A 10 s start delay per run if the marker changes; broken or missing videos otherwise. Not on any default path.
- Proposed fix: (1) in `startSimRecording`, treat `proc.exited` before the marker as a failure and reject with the stderr text; (2) on the 10 s timeout, kill the process and reject instead of assuming; (3) `stop()` returns the exit code and `teardown` warns on non-zero or when the file is missing; (4) make `spawn` injectable so the three cases are tested. Files: `batch/record.ts`, `commands/batch.ts:588-600,1396` (12). Additive.
- Effort: S
- Risk: low. Needs a device to confirm the real marker text and exit behaviour.
- How to verify: `record.test.ts` with an injected fake process (exits at once; never prints; prints the marker). On device: `xcrun simctl io <shutdown udid> recordVideo --codec h264 --force /tmp/x.mp4` and read the exit code and stderr.
- Confidence: high on the early-exit path, med on the marker text staying stable.
- Verified by: read; traced from `startRecordings` to `startSimRecording` and `teardown`.

### 13-4 Nothing measures the parent process; K12's 12.1 % does not include it
- Category: test-gap
- Severity: P2
- Known?: known-extended K12 (also K2)
- Evidence:
  - The bench runs `bun test` directly, so there is no `warden e2e` parent in its host CPU/RSS samples (assignment note on K12; I did not read the harness). The plan's PERF-5.1 acceptance, "bench host CPU avg ≤ 5 % for a `warden e2e example` run" (`docs/plans/wdn-perf.md:381`), was never measured on the parent: the Results table gives only the bench's 12.1 % / 149 MB (`:647`).
  - What did land and checks out: poller offset tracking (`flow-poller.ts:75`, `results-tail.ts:14-25,54-84`) and `FRAME_MS` 100 → 1000 (`commands/batch.ts:224`). `bun scripts/bench-flow-poller.ts` (5000 results over 100 polls, 1.5 MB): legacy 5933 ms CPU vs incremental 84.1 ms, "71x less CPU", i.e. about 16.8 µs per result line. `bun test src/batch src/e2e/verdicts.test.ts`: 106 pass, 0 fail (2 snapshots, untouched).
  - Rough steady state for 8 workers (estimated; the output rate is my assumption): per second one `stat` per running worker (`results-tail.ts:15`) plus an `open`+`read` only when the file grew; one frame at 84 µs per `render` of 8 devices (measured, 5000 renders, colour on) plus about 3 events per job; stamping + `writeSync` at 6.2 µs per chunk (measured, 20 000 chunks of 3 lines). At an assumed 50 chunks/s/worker that is 8 × 50 × 6.2 µs ≈ 2.5 ms/s, so about 3 ms of CPU per second in total, roughly 0.3 % of one core. No retained buffers: logs are written straight through (`stamped-log.ts:27`), `batch.json` is built once (`summaryJson` is called only from `report`, `batch.ts:782`, not per frame), the result arrays are a few KB.
  - So the parent's own work does not explain 12.1 % host CPU; the RSS growth 116 → 149 MB (K2) is not in the observe path either, since nothing here retains more than a few MB.
- Impact: this is a measurement gap, not a saving. It means a regression in the parent (a poller change, a bigger frame) would not show in any number the repo tracks.
- Proposed fix: add the parent to the sampler. Run `warden e2e example` under the bench harness (or `bun scripts/…` that samples `ps -o %cpu,rss -p <pid>` of the `warden` pid and its children by name at 1 Hz) and write per-process rows (this is K2's missing per-process split). Files: `packages/e2e-bench/src/harness/sampler.ts` (owner outside my scope), a new script in `apps/cli/scripts/`. Additive.
- Effort: M
- Risk: low; needs a device host to produce real numbers.
- How to verify: run it on the bench host with 2 iOS sims and 2 Android emulators; expect the parent below 1 % CPU and below 100 MB, or learn where it is not.
- Confidence: high that the gap exists, med on the 0.3 % estimate.
- Verified by: ran `bun scripts/bench-flow-poller.ts`, ran the owned tests, ran two throwaway micro-benchmarks in the scratchpad (stamper+`writeSync`, `render`).

### 13-5 Every results line is parsed 3 times, and `realpathSync` runs uncached per result × flow in the verdict pass
- Category: perf-cpu
- Severity: P3
- Known?: new
- Evidence:
  - Parse 1: the poller (`results-tail.ts:28-37`, zod `safeParse`). Parse 2: `readRunnerReport` re-reads every attempt's whole file and runs `readResults` (`batch.ts:548-549` → `runner-report.ts:27`). Parse 3: `verdicts` re-reads each file once through `resultsLoader` (`verdicts.ts:86-99`; `readResults` at `:93`). A shard retry parses the failed attempt's file once more (`apps/cli/src/e2e/jobs.ts:81-82`).
  - `flowOf` calls `real()` for the result and for each tracked flow until it matches, with no cache: `flow-progress.ts:26-33`, called per result from `runner-report.ts:28`, from `verdicts.ts:127` and `:131`, and again for `jobs.ts:82` via `judgeJob`. `flowTracker` memoises (`flow-progress.ts:58-74`), but only the poller uses it. `realpathSync` measured at 3.1 µs per call here (50 000 calls on this host).
  - `verdicts.ts:128` copies the array per result (`[...(byFlow.get(id) ?? []), r]`), which is quadratic in tests per flow.
  - Cost with the bench's 16.8 µs per line: a 100-result run with 8 flows is about 2 × 100 extra parses ≈ 3.4 ms plus about 100 × 5.5 × 2 ≈ 1100 `realpath` calls ≈ 3.4 ms. A 1000-result, 50-flow run is about 1000 × 26 × 2 × 3.1 µs ≈ 160 ms of verdict-pass time after the last job. Estimated from those two measured unit costs.
- Impact: estimated, under 10 ms per typical run; about 0.15 s on a very large suite, on the post-run path. No effect on the 8-test rep.
- Proposed fix: share one `real` memo (`Map<string,string>`) behind the default `realPath` and pass it to `flowOf`/`judgeJob`; have `flowPoller` expose the parsed results per attempt key (it already holds them transiently) so `readRunnerReport` and `verdicts` read from that cache and only fall back to a file read for keys it has not settled; use `push` at `verdicts.ts:128`. Files: `batch/flow-progress.ts`, `batch/flow-poller.ts`, `batch/runner-report.ts`, `e2e/verdicts.ts`, `e2e/jobs.ts` (the last is agent 12's neighbour). Additive. Low priority: only worth doing with the other changes in these files.
- Effort: S
- Risk: low. The cache must be invalidated for a replaced file (the poller already handles `reset`).
- How to verify: existing `verdicts.test.ts` and `runner-report.test.ts` stay green; add a count of `real` calls per path.
- Confidence: high
- Verified by: traced path from the poller to `readRunnerReport` to `verdicts`; measured unit costs.

### 13-6 The parent still stamps every log chunk (the plan says the child should), and `drained` polls every 10 ms
- Category: perf-cpu
- Severity: P3
- Known?: claimed-fixed-not-landed (`docs/plans/wdn-perf.md:380`: "children stamp their own lines; the parent pipes bytes straight through"; the other two PERF-5.1 bullets did land)
- Evidence:
  - `defaultBatchDeps.spawn` sets `WARDEN_LOG_TIMESTAMPS: "1"` (`commands/batch.ts:1788`). In the child that value only turns its own clock off (`packages/e2e/src/runner/attempt.ts:157`, `trace.ts:113`: "false under `WARDEN_LOG_TIMESTAMPS=1` (warden stamps the log)"). The parent decodes each chunk, splits it, prefixes lines and calls `writeSync` once per chunk of each child, on the supervisor thread (`stamped-log.ts:27,37-41`, `stamp-lines.ts:15-26`). That is the opposite of the plan bullet.
  - Measured here: 6.2 µs of CPU per 3-line chunk (20 000 chunks), so it is not worth removing for CPU (13-4: about 0.25 % of a core at an assumed 50 chunks/s/worker).
  - A side effect of parent stamping: all lines in a chunk get the chunk's arrival time (`stamp-lines.ts:19`), so under host load the stamps can lag the true emission time, in logs that are used to explain untraced time (K1).
  - Drain: after exit, `drained` sleeps in 10 ms steps while any pump is alive (`stamped-log.ts:20,48-55`) with a 250 ms quiet window and 2 s ceiling (`batch.ts:1777-1800`). Normal case: up to 10 ms added per job. If a grandchild holds the pipe open (an adb daemon started by the spec, say) each job pays 250 ms, or up to 2 s if it keeps writing. I could not find a grandchild that inherits the pipes in the code, so I cannot say how often this happens.
- Impact: estimated. At most 10 ms per job normally (about 80 ms per rep per device only under `isolate: "flow"`, 8 jobs); 0.25 to 2 s per job in the grandchild case, which is unmeasured. Parent CPU saving from moving the stamp: under 0.3 %.
- Proposed fix: close the plan bullet as "won't do, measured 6 µs/chunk" and document that stamps are arrival times. Make `drained` event-driven (a promise resolved when `pumping` reaches 0, raced against the quiet timer), and have `exited` record how long the drain waited into the job's entry so a grandchild-held pipe shows up in `batch.json`. Files: `batch/stamped-log.ts`, `commands/batch.ts:1799-1801` (12). Additive.
- Effort: S
- Risk: low
- How to verify: `stamped-log.test.ts` (fake stream that ends after the exit; one that never ends). On device, run `warden e2e example` on Android and log the drain wait per job.
- Confidence: med
- Verified by: read; ran a throwaway stamper benchmark.

### 13-7 A failed log write ends the pump, so the child's pipe stops being read
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: `pump` wraps the whole `for await` loop in one `try/catch` whose comment expects "the stream broke or the file closed" (`stamped-log.ts:36-45`). `close()` already makes later writes no-ops (`:27`), so the only thing that can throw inside the loop is `writeSync` itself (ENOSPC, EDQUOT, EIO). Then the iterator is returned and the stream is cancelled, so the child's next write to stdout/stderr hits a closed pipe (EPIPE) and a test process can die with no log at all. `stamped-log.test.ts:53` covers the close case only.
- Impact: only on a full or failing disk, where `results.jsonl` and the artifacts fail too; the new thing is that the failure is silent and the child dies for a reason that is not in any log. Platform: both.
- Proposed fix: wrap `write` itself: on error set a `broken` flag, warn once through an injected callback, and keep reading and discarding so the child never blocks or gets EPIPE. Files: `batch/stamped-log.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: `stamped-log.test.ts` with an injected writer that throws on the second call; the pump must still consume the stream to its end.
- Confidence: med (the EPIPE effect inside Bun's child is my reading, not run)
- Verified by: read

### 13-8 `tui.cast` height is fixed at the first frame, and the live grid ignores terminal resizes
- Category: dx
- Severity: P3
- Known?: new
- Evidence:
  - `display()` computes `width` and `height` once from the initial view (`commands/batch.ts:443-446`). `Cast.resizeTo` exists (`batch/cast.ts:19`) but nothing calls it (grep over `apps/cli/src`).
  - In a sharded run the first view has runners with no flows (`startView` → `withRunners(view, [])`, `batch.ts:554-562`) and each `job-start` adds the shard's flows (`:465-467`, `addRunnerFlows`, `tui.ts:72`), which adds flow lines under the device rows (`tui.ts:312-341`). The recorded terminal is therefore shorter than the grid by at least one line per worker.
  - `width` is read once; a window resize mid-run changes how lines wrap, while `liveScreen` moves the cursor up by the number of lines it last drew (`tui.ts:349,362`), so the old frame is not fully erased.
- Impact: playback of `tui.cast` clips the grid for sharded runs; a resized live terminal leaves frame fragments. No effect on timing.
- Proposed fix: call `cast.resizeTo(text.split("\n").length + 1)` for the cast sink in `frame()`, and read `terminal.columns` per frame for the live sink. Files: `commands/batch.ts:450-458` (12). Additive.
- Effort: S
- Risk: low
- How to verify: a `batch.test.ts` case that records a sharded run and checks the `.cast` header height against the final frame.
- Confidence: high
- Verified by: read; grep for `resizeTo`.

### 13-9 A throwing sink in the poller's timer becomes an unhandled rejection
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: the timer callback is `if (!underway) void poll()` (`flow-poller.ts:85-87`). `look` awaits `pollOne` per file, which calls `sink.flows`/`sink.tests` (`:64,71`); in production these are `display().flows` and `.tests`, which render and write to the terminal (`commands/batch.ts:475-482`). Read errors are caught inside `createResultsTail` (`results-tail.ts:61`), but a throw from the sink is not, and the `void` drops the rejection. The final awaited `poller?.poll()` (`batch.ts:532`) would rethrow the same error into `runSession`'s `catch` (and into 13-1). Same family: `serve.ts:36` never consumes or cancels the `fetch` response body of each readiness probe (about 2 probes/s for up to `--serve-timeout`).
- Impact: low. A rare crash of the supervisor with a stack trace instead of a handled error.
- Proposed fix: `void poll().catch(() => {})` in the timer (the next tick retries, the final `poll()` surfaces any persistent error); `res.body?.cancel()` in `probeReady`. Files: `batch/flow-poller.ts`, `batch/serve.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: `flow-poller.test.ts` with a sink that throws once; assert no unhandled rejection and that the next tick delivers.
- Confidence: low (I did not run it; the Bun unhandled-rejection exit behaviour is assumed to match Node)
- Verified by: read

## Known items

- K12: known-extended. 13-4: the bench's 12.1 % host CPU excludes the parent; the parent's own work is about 0.3 % of a core (estimated), so the 5 % target cannot be reached or missed by changes in this area.
- K2: known-extended. 13-4: the per-process split is also what would show the parent's RSS; nothing in the observe path retains more than a few MB.
- K1: touched. Parent-side stamping makes log times arrival times (13-6), which matters when logs are used to place untraced time.
- K14: not confirmed in my files. The "no results.jsonl" warning is produced in `verdicts.ts:167-168` only when a job fell back to its exit code; I did not trace a fully skipped flow.
- K13: not touched.
- PERF-5.1: poller and frame rate landed and verified (bench run above, `FRAME_MS = 1_000` at `commands/batch.ts:224`); the stamping bullet did not land (13-6).
- Assignment guesses refuted: `summaryJson` is built once, in `report` (`batch.ts:782`), not per frame; the TUI snapshots are two 3-line views in a 13-line file (`__snapshots__/tui.test.ts.snap`), and every other TUI test asserts text, so they are not brittle.

## Gaps I could not assess here

- Real parent CPU/RSS during `warden e2e example`: run it with a 1 Hz `ps -o pid,%cpu,rss,command -p <warden pid>` sampler beside the bench's own sampler, on 2 sims and 2 emulators, 3 reps.
- iOS cost of the post-failure screenshot: 20 timed runs of `xcrun simctl io <udid> screenshot /tmp/x.png`.
- Real `simctl recordVideo` stderr text and exit behaviour on a shut-down device (13-3).
- Whether any spec-spawned grandchild holds the stdout/stderr pipes after the spec exits (13-6): log how long `drained` waits per job on Android, where `adb` may start its server.
- Terminal behaviour of 13-1 and 13-8 needs a TTY.

## Owned files not read

Read in full: `flow-poller.ts`, `results-tail.ts`, `flow-progress.ts`, `runner-report.ts`, `stamped-log.ts`, `stamp-lines.ts`, `tui.ts`, `record.ts`, `cast.ts`, `serve.ts`, `screenshot.ts`, `e2e/verdicts.ts`, `scripts/bench-flow-poller.ts`.
Not read line by line (ran them: 106 pass; read only test names, snapshot and some greps): `tui.test.ts`, `flow-poller.test.ts`, `results-tail.test.ts`, `flow-progress.test.ts`, `runner-report.test.ts`, `stamped-log.test.ts`, `stamp-lines.test.ts`, `record.test.ts`, `cast.test.ts`, `serve.test.ts`, `screenshot.test.ts`, `e2e/verdicts.test.ts`, `results.testing.ts`.

## Questions for the user

None.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-13.md`, `docs/plans/wdn-perf.md` (PERF-5, Results, Follow-ups), `apps/cli/CLAUDE.md`, `packages/e2e/CLAUDE.md`
- `apps/cli/src/batch/{flow-poller,results-tail,flow-progress,runner-report,stamped-log,stamp-lines,tui,record,cast,serve,screenshot}.ts`, `apps/cli/src/batch/__snapshots__/tui.test.ts.snap`
- `apps/cli/src/e2e/verdicts.ts`, `apps/cli/src/e2e/jobs.ts:40-130`, `apps/cli/src/commands/e2e.ts:285-345`
- `apps/cli/src/commands/batch.ts` (200-600, 600-930, 1180-1200, 1370-1470, 1760-1856), `apps/cli/src/lease-session.ts:495-505`, `apps/cli/src/cli.ts` (grep)
- `apps/cli/scripts/bench-flow-poller.ts`, `packages/e2e/src/runner/results.ts`
- Scratchpad scripts (not in the repo): `mb13.ts`, `rp13.ts`, `rss13.ts`
