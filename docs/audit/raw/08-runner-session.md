# 08 · runner-session

Scope: `packages/e2e/src/runner/*`, `session.ts`, `preload.ts`, `env.ts`, `fixtures.ts`, `fixture-session.ts`, `traced-device.ts`, `index.ts`, `version.ts`. The source tree at HEAD (`d6629f7`) is identical to `dfcc68b` under `packages/` and `apps/` (`git diff --stat dfcc68b HEAD -- packages apps` is empty), so every `@dfcc68b` line holds.

Method note: four behaviours were checked by running throwaway spec files in my scratchpad (`/tmp/claude-0/-home-user-warden/0a2fe730-4741-59a0-9ff9-2eb7af339b55/scratchpad/probe08*`) against the repo's own fake-driver preload (`packages/e2e/src/runner/fixtures/preload.ts`), with `bun test` and `WARDEN_HOME=.../home-08`. Nothing in the repo was changed. The probe output is quoted where it is used.

## Top 5 by impact

- **08-1**: a timed-out test body, or a timed-out hook, keeps running. Its taps then land in the next test, with a live signal, and are written to that test's trace (probe-verified). P1.
- **08-2**: the time the runner allows after a deadline (3 × 10 s capture plus 10 s per hook and per teardown) is not bounded by bun's 30 s margin. Bun then gives up on the test and starts the next one while the old cleanup is still running. The old `leaveAttempt()` wipes the new attempt, and results lines come late or are lost (probe-verified). P1.
- **08-3**: retries share one attempt dir. A passed result lists the failed attempt's screenshots, `trace.jsonl` holds every attempt back to back, and `failure.png` stays next to a pass (probe-verified). P2.
- **08-5**: failure capture is serial and its calls are never cancelled. On a wedged device that is up to 30 s per failing test, and the abandoned calls stay queued ahead of the next test's launch. P2.
- **08-4**: `beforeAll`/`afterAll` run with no deadline, no trace and no failure capture. When one throws, its scope writes zero `results.jsonl` lines (probe-verified). P2.

## Findings

### 08-1 A timed-out body or hook keeps running and drives the device during cleanup and the next test
- Category: flake-risk
- Severity: P1
- Known?: new
- Evidence:
  - The deadline only *races* the work: `Promise.race([setUpAndRun(...), deadline])` at `packages/e2e/src/runner/attempt.ts:204@dfcc68b`, and cleanup hooks use `limited()` (`attempt.ts:115-121@dfcc68b`, used at `:331`). Neither cancels the losing promise.
  - Fixtures read the attempt state from the session **at call time**, never from the attempt they were built for:
    - screen: `get signal() { return session.signal; }` and `step: … session.step("locator", …)` (`packages/e2e/src/fixtures.ts:32-35@dfcc68b`)
    - device: `const signal = () => session.signal` (`packages/e2e/src/device.ts:117-118@dfcc68b`)
    - app: `session.signal` per call (`app.ts:62,77@dfcc68b`)
  - `session.step` and `session.signal` resolve against whatever attempt is current (`packages/e2e/src/session.ts:180-182,236-238@dfcc68b`).
  - The runner swaps that slot three times after a deadline:
    1. the cleanup context with a fresh, non-aborted signal (`attempt.ts:326-327@dfcc68b`);
    2. `undefined` (`attempt.ts:220@dfcc68b`). `runStep` then just runs `fn()` with no deadline (`runner/step.ts:35@dfcc68b`), and `session.signal` becomes the never-aborting `idle` (`session.ts:161@dfcc68b`);
    3. the next test's context (`attempt.ts:186@dfcc68b`).
  - `unwrap`/`settled` refuse to start a call only when the signal *passed at that moment* is aborted (`driver/unwrap.ts` `settled`). Once the slot has been swapped, a zombie's call passes that check.
  - Probe: test A had `timeout: 300`. Its body did `await setTimeout(600)`, then `session.step("zombie", …)`, then `screen.getByText("Welcome").tap()`. Test B slept 1 s. Output:
    - A was reported `timed-out 0.31s`.
    - Then, *inside B*: `▸ z › zombie after-deadline`, `PROBE zombie step ran; attempt signal aborted=false`, `▪ z › locator tap getByText("Welcome") passed 3ms`, `PROBE zombie tapped`.
    - Both steps are in `out/z/victim-b33e75/trace.jsonl`, B's trace.
  - Realistic triggers:
    - a body `try { … } catch {}` retry loop around a step (the TIMEOUT is swallowed and the loop goes on);
    - a body or hook awaiting something that ignores the signal (`fetch` to a backend, `Bun.spawn`, a sleep helper);
    - an `afterEach` that is still running when `limited()` gives up after 10 s.
  - The abandoned in-flight driver call also stays on the wire. `captureFailure` then sends `screenshot`/`snapshot` (`attempt.ts:216@dfcc68b`) while that call is still in progress.
- Impact: estimated. It turns one timed-out test into a second failure, or a false pass, in the next test. The extra taps land on the next test's screen, which is the classic cascade that reads as flake. It only happens after a timeout, but timeouts are exactly the runs people triage. Both platforms.
- Proposed fix: bind each attempt's fixtures to that attempt.
  - Give the fixture factory an attempt-scoped session view: `signal` = the attempt signal, swapped to the cleanup signal only for that attempt's own cleanup, and an aborted `"attempt finished"` signal once `leaveAttempt` ran; `step`/`span` = `runStep(capturedCtx, …)`. `FixtureContext.signal` already exists (`runner/fixtures.types.ts`), but `screenHostFor` ignores it.
  - Make `leaveAttempt(ctx)` / `enterAttempt` compare identity, so they never clear a context they did not set.
  - Touch `runner/attempt.ts`, `session.ts`, `fixtures.ts` (and the `device.ts`/`app.ts` signal reads, agent 09). Additive (no `Driver` or env change).
- Effort: M
- Risk: low to medium. `afterEach` hooks must keep working after a timeout (they need the live cleanup signal). The fake driver is enough to verify; no device needed.
- How to verify:
  - New `runner/fixtures/zombie.e2e.ts` + a case in `runner/runner.test.ts`: a body that sleeps past its deadline, then taps. Assert that the next test's trace has no foreign steps and that the tap rejects with `TIMEOUT`/`SESSION`.
  - Same for an `afterEach` that outlives `CLEANUP_TIMEOUT_MS` (use a small injected value).
- Confidence: high
- Verified by: ran a probe spec under the repo's fake preload; traced the path from `runAttempt` through `session.step` to `runStep`.

### 08-2 Post-deadline work is not bounded by bun's margin: bun starts the next test while the old cleanup still runs
- Category: robustness
- Severity: P1
- Known?: new (it makes K5's "crash blame inferred from result order" worse)
- Evidence:
  - Bun's own per-test timeout is `timeoutMs + BUN_TIMEOUT_MARGIN_MS` (`runner/test.ts:101@dfcc68b`; `runner/scope.ts:12@dfcc68b` sets it to 30 s).
  - After warden's deadline the runner still does, in series:
    - `captureFailure`: `driver.screenshot` ≤ 10 s, then `driver.snapshot` ≤ 10 s (`runner/failure.ts:13,49,63@dfcc68b`);
    - `captureDevtoolsArtifacts` ≤ 10 s (`failure.ts:89@dfcc68b`; called serially at `attempt.ts:303-304@dfcc68b`);
    - then every `afterEach` and every fixture teardown, each ≤ 10 s (`attempt.ts:13,331@dfcc68b`).
  - None of these limits are counted against one budget. On a wedged device (K7 AX wedge, K16 30 s launch) the two driver captures alone take 20 s. One device-touching `afterEach` then reaches the 30 s margin.
  - Second trigger: bun's timeout is fixed at registration from the `test.use` *seen so far* (`test.ts:77@dfcc68b`), while the attempt resolves `test.use` at run time (`attempt.ts:150@dfcc68b`). A `test.use({ timeout: 200_000 })` written below a test gives a 200 s warden deadline under a 150 s bun timeout.
  - Probe: `timeout: 100` and 4 `afterEach` hooks of 8 s each.
    - Bun printed `(fail) slow cleanup [30100.96ms] ^ this test timed out after 30100ms`.
    - It then started `▶ … › next` (`PROBE next body …447147`) *before* the old test's last hook finished (`PROBE afterEach 3 done …449061`) and before its `■ … slow cleanup failed 32.02s` line.
    - The old attempt's `session.leaveAttempt()` (`attempt.ts:220@dfcc68b`) therefore ran while `next` was the current attempt and cleared it. `next`'s later steps lose their trace and their deadline (same mechanism as 08-1).
    - `results.jsonl` ended with 1 line for 2 tests.
- Impact: estimated. On a wedged device, a failing test overlaps the next one by up to (30 s + 10 s × hooks) − 30 s. Results lines arrive out of order or not at all, so the CLI's verdict and K5's order-based blame point at the wrong test. Both platforms.
- Proposed fix:
  - One post-deadline budget, e.g. `BUN_TIMEOUT_MARGIN_MS − 5 s`, shared by capture, hooks and teardowns, each taking the remainder.
  - Skip the snapshot when the screenshot timed out (the device is not answering); see 08-5.
  - Resolve bun's timeout lazily, or warn when a `test.use({timeout})` comes after a test in the same scope.
  - Combine with the identity-checked `leaveAttempt` from 08-1.
  - Touch `runner/attempt.ts`, `runner/failure.ts`, `runner/test.ts`. Additive.
- Effort: M
- Risk: low. A hook that legitimately needs more than its share is cut sooner. Verify with the fake driver.
- How to verify: a runner fixture with N slow `afterEach` hooks (an injected small `CLEANUP_TIMEOUT_MS`). Assert that `■` of test 1 prints before `▶` of test 2 and that `results.jsonl` has one line per test.
- Confidence: high
- Verified by: ran a probe spec (4 × 8 s `afterEach`); read `test.ts`/`attempt.ts`/`failure.ts`.

### 08-3 Retries (and same-title tests) share one attempt dir: stale screenshots and failure files in a passed result; traces concatenated
- Category: correctness
- Severity: P2
- Known?: new (the same per-attempt reset gap as K14)
- Evidence:
  - The dir is `hash6(spec.file, ...spec.title)`, identical for every attempt (`attempt.ts:159@dfcc68b`; `runner/artifacts.ts:20,25@dfcc68b`). Nothing clears it.
  - `openTrace` appends (`runner/trace.ts:61@dfcc68b`).
  - `listScreenshots` adds every file in `screenshots/` (`attempt.ts:124-130,228@dfcc68b`).
  - Probe: `retry: 1`, each attempt saving a screenshot, attempt 1 throwing. The only results line is `status:"passed"` with `artifacts.files: ["screenshots/001-attempt-1.png","screenshots/002-attempt-2.png","trace.jsonl"]`. The dir also holds `failure.png` and `screen-at-failure.txt` from the failed attempt, and `trace.jsonl` has 2 `app.open` step-starts with no attempt delimiter.
  - Two tests with the same title path in one file get the same dir as well.
- Impact: estimated. It misleads triage, because a pass shows a failure screenshot and a trace twice as long. It also breaks any per-test parsing of `trace.jsonl` (the bench's `untracedMs` per test, agent 19, reads it per result). No time cost.
- Proposed fix: one subdir per attempt (`<dir>/attempt-<n>/`, or `-r<n>` when n > 1), or `rmSync(dir)` at attempt start when n > 1 (keeping the earlier attempt for triage is better). Add the attempt number to `TestResult`, which is a `store`-like schema bump read by the CLI (agent 13). Touch `runner/attempt.ts`, `runner/test.ts` (pass `attempts`), `runner/results.ts`.
- Effort: S
- Risk: low. Consumers of `artifacts.dir` must follow the new layout.
- How to verify: extend `runner/fixtures/retry.e2e.ts` with a screenshot per attempt. Assert that the passing result lists only its own files.
- Confidence: high
- Verified by: ran a probe spec with `retry: 1`.

### 08-4 `beforeAll`/`afterAll` run outside any attempt: no deadline, no trace, no capture, and a throw writes no results lines
- Category: robustness
- Severity: P2
- Known?: new (it adds to K14's "no results.jsonl" path)
- Evidence:
  - `sharedFixtures` builds the fixtures with `session.signal` while no attempt is running (`runner/test.ts:189-198@dfcc68b`). That is the `idle` signal, which never aborts (`session.ts:161,180-182@dfcc68b`). Every `app`/`device`/`screen` call in these hooks therefore has no deadline until bun's own T + 30 s.
  - `runStep`/`runSpan` without an attempt just run `fn()` (`runner/step.ts:35@dfcc68b`, `runner/span.ts:66@dfcc68b`). Nothing is traced and no failure capture runs.
  - Probe: `beforeAll(async ({app}) => { await app.open(); throw … })` with two tests. Bun printed `(fail) (unnamed)`, `results.jsonl` was never created (0 lines), and the run exited 0.
  - The time a `beforeAll` spends (seeding, a launch) is in no test's `durationMs` and in no trace, so it also escapes the bench's untraced accounting (K1).
- Impact: estimated. A suite whose `beforeAll` fails reports no tests at all. The CLI falls back to its "no results.jsonl" warning and the exit code. A hung `beforeAll` driver call blocks for the full bun timeout (default 150 s) instead of the 120 s test deadline. Both platforms.
- Proposed fix:
  - Run `beforeAll`/`afterAll` inside a pseudo-attempt (`runAttempt`-lite): its own deadline (`timeoutMs`), a `trace.jsonl` under `<flowId>/_beforeAll-<hash>/`, and failure capture.
  - On a throw, append one `failed` results line per test of the scope (the titles are known at collection), with `error.code` set to `HOOK`.
  - Touch `runner/test.ts`, `runner/attempt.ts`. The extra result lines touch the results contract that the CLI reads (agent 13).
- Effort: M
- Risk: low to medium. It changes what `results.jsonl` holds for hook failures. Verify with the fake driver.
- How to verify: `runner/fixtures/before-all-throws.e2e.ts` + a runner.test case asserting one `failed` line per test and a trace file.
- Confidence: high
- Verified by: ran a probe spec; read `test.ts`, `session.ts`.

### 08-5 Failure capture is serial and its calls are never cancelled: up to 30 s per failing test, and the calls stay queued ahead of the next launch
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `captureFailure` awaits `driver.screenshot` and then `driver.snapshot`, each `limited(…, 10_000)` with a `Promise.race` that abandons the call without aborting it. No signal is passed to the driver (`runner/failure.ts:15-21,49,63@dfcc68b`).
  - `captureFailureArtifacts` then awaits the devtools drain, also limited to 10 s (`attempt.ts:303-304@dfcc68b`).
  - When the screenshot times out, the device is not answering, yet the snapshot is still tried for another 10 s.
  - The abandoned calls are still in flight on the helper or `warden-uiad` when the next test's `app.open` is sent (`attempt.ts:282@dfcc68b`).
- Impact: estimated.
  - Healthy device: the two reads could overlap and save min(screenshot, snapshot). That is ~100–300 ms per failing test on iOS (iOS reads cost ~100–300 ms per `observation-cache.ts:16`).
  - Wedged device: 20–30 s → ≤ 10 s per failing test, and the abandoned calls no longer delay the next test.
  - Only failing tests pay.
- Proposed fix:
  - Run screenshot ‖ snapshot ‖ devtools with `Promise.allSettled` under one shared 10 s budget.
  - Pass an `AbortSignal` to the driver calls (`settled(…, signal)` as `unwrap` does), so a cut call is also dropped by the driver where it supports that (agents 03/05).
  - Touch `runner/failure.ts`, `runner/attempt.ts`. Additive.
- Effort: S
- Risk: low. Two reads at once on a helper that serialises ops gain less; the result is never worse than today. Verify the wall time on a device.
- How to verify: `runner/failure.test.ts` with a fake driver whose screenshot never resolves. Assert that capture returns in ≤ budget and still writes `screen-at-failure.txt` when the snapshot answers.
- Confidence: med
- Verified by: read `failure.ts`, `attempt.ts`.

### 08-6 The runner never marks or clears the devtools console/network ring per attempt (K14)
- Category: correctness
- Severity: P2
- Known?: known-extended K14
- Evidence:
  - The facet offers `console.mark` / `clear` and `network.clear` (`devtools/facet.ts:80-82@dfcc68b`, `devtools/console.ts:161,255-258@dfcc68b`). Nothing in `runner/` calls them: `grep -rn "\.mark\b\|clear(" packages/e2e/src/runner` → none.
  - `enterAttempt` (`attempt.ts:186@dfcc68b`) only sets the slot.
  - `captureDevtoolsArtifacts` dumps the whole ring (`devtools/facet.ts:88-96@dfcc68b`). A failing test's `console.jsonl` therefore holds every earlier test's lines from the same spec process, as `docs/plans/wdn-e2e.md:469` reports.
- Impact: n/a (triage quality); dev builds only.
- Proposed fix:
  - At attempt start, call `session.peekDevtools()?.console.mark("▶ <title>")` and remember the ring position.
  - Give `attachArtifacts(dir, { since })` a cut-off so it writes only this attempt's lines, or call `clear()` at attempt start if earlier lines are never wanted.
  - Touch `runner/attempt.ts`, plus `devtools/facet.ts` (agent 10). Additive.
- Effort: S
- Risk: low. Verify with the devtools fake (`failure.devtools.test.ts`).
- How to verify: in `runner/failure.devtools.test.ts`, two attempts that log different lines. The second attempt's `console.jsonl` must hold only its own lines.
- Confidence: high
- Verified by: read; grep.

### 08-7 Driver open happens lazily inside the first test's attempt, serial with spec collection and untraced (K1 residue)
- Category: perf-latency
- Severity: P3
- Known?: known-extended K1
- Evidence:
  - The preload's doc says it "opens the session eagerly" (`preload.ts:50@dfcc68b`), but it only creates the session (`preload.ts:67@dfcc68b`).
  - The driver opens on the first `session.driver()` (`session.ts:193@dfcc68b`). That call is `defaultFixtureFactory` → `await session.driver()` (`fixtures.ts:48@dfcc68b`), reached from `buildBaseFixtures` before the first step (`attempt.ts:279@dfcc68b`).
  - The open is not a span (the traced proxy wraps the opened driver, `session.ts:200@dfcc68b`), so its time lands in the first test's untraced residue.
  - On iOS the open is socket connect ‖ `enableAutomation` (plutil, ~10 ms; 300–500 ms when it must write) (`driver/ios/ios-driver.ts:536@dfcc68b`). On Android it also reads and sets the animation scales.
  - Per-flow isolation pays this once per process (`docs/plans/wdn-perf.md:365`: ~150–250 ms per process for bun start, preload, driver connect, plutil).
- Impact: estimated. Starting the open in the preload, without awaiting it, overlaps it with spec import and collection. Importing `src/index.ts` + `preload.ts` measured 59–74 ms + 16–20 ms here, on an idle host. That saves up to ~60–80 ms per spec process, so ~0.3–0.4 s per 5-flow rep with per-flow processes. The open time also becomes visible as a `driver.open` span, part of the 0.27 s / 0.11 s K1 residue.
- Proposed fix:
  - In `installPreload`, call `void session.driver().catch(() => undefined)`. A failed open is already retried on the next call (`session.ts:194-206@dfcc68b`).
  - Record the open as a `driver.open` note or span in the first attempt that awaits it.
  - Fix the doc line.
  - Touch `preload.ts`, `session.ts`. Additive.
- Effort: S
- Risk: medium. On Android, opening sets the animation scales even when every test of the process is skipped (they are restored on close). Skip the eager open when collection found no runnable test, if that matters. Needs a device to measure.
- How to verify: the bench `untracedMs` of the first test per process, before and after (`bun run bench run --platform ios --runs 3`). Unit test: `preload.test.ts` asserts that `driver()` is called once at install.
- Confidence: med
- Verified by: read; timed the module import with `bun -e`.

### 08-8 Spans after `flush()`, and buffered spans of a running step, are lost on a late call or a kill
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - Spans are buffered until the next non-span event or 256 spans (`runner/trace.ts:50,72-80@dfcc68b`).
  - A long locator or `expect` step that polls for 15 s keeps all its `driver.snapshot` spans in memory until `step-end`. If warden SIGTERMs the spec process on its outer timeout, they are gone. The trace then lacks exactly the window of the hang.
  - After `trace.flush()` (`attempt.ts:221@dfcc68b`), a span from a call that outlived its attempt is still sent to that attempt's writer (`runner/span.ts:57-60@dfcc68b`, by design). But nothing flushes that writer again, so the span is silently dropped (`trace.ts:45@dfcc68b` says so).
- Impact: n/a (diagnostic loss), mainly in the hang and timeout cases.
- Proposed fix:
  - In `openTrace`, flush on a timer as well (e.g. every 1 s while `pending.length > 0`; `unref()` the timer).
  - After `flush()` has run, mark the writer "closed" and append late spans directly (one `appendFileSync` per late span is fine).
  - Touch `runner/trace.ts`. Additive.
- Effort: S
- Risk: low.
- How to verify: `trace.test.ts`: a write after `flush()` reaches the file, and a buffered span reaches the file within the interval with no further event.
- Confidence: high
- Verified by: read.

### 08-9 Preload docs contradict behaviour: the version check "is a warning" but exits 2; "opens the session eagerly" does not open the driver
- Category: dx
- Severity: P3
- Known?: new
- Evidence:
  - `preload.ts:32@dfcc68b` says "A mismatch is a warning, not an error (most pairs still work)". The message says "refusing to run" (`preload.ts:38@dfcc68b`) and `installPreload` calls `deps.exit(2)` (`preload.ts:63@dfcc68b`).
  - `preload.ts:50@dfcc68b` "opens the session eagerly" (see 08-7).
- Impact: n/a
- Proposed fix: correct both comments (or make the check a warning if that was the intent; the plan says lock-step). Touch `preload.ts`.
- Effort: S
- Risk: low
- How to verify: read.
- Confidence: high
- Verified by: read.

### 08-10 `launch: "fresh"` cannot wait for the app, so every real suite opts out and relaunches by hand
- Category: dx
- Severity: P3
- Known?: known-extended K15
- Evidence:
  - The runner's launch is `base.app.open()` with no options (`attempt.ts:282@dfcc68b`), which is `wait: "none"` (`app.ts:68@dfcc68b`).
  - The idiomatic bench suite therefore sets `launch: "none"` and calls `app.open({ wait: "quiet" })` itself. Its own comment says the runner's bare `app.open()` "would be a second launch" (`packages/e2e-bench/suites/warden/helpers/flows.ts:8-13@dfcc68b`).
  - Checked: nothing in the runner duplicates the launch path. There is one `app.open` step per test with `fresh`, none with `none`, and no runner-side settle or alert probe. The 8 launches per rep (12.8 s, `docs/bench/ios-2026-10-16-perf.md:141`) are all the spec's own.
- Impact: n/a for the bench (it already avoids the double launch). A new user who keeps the default and calls `app.open({wait:"quiet"})` in `beforeEach` pays a second launch per test: ~1.6 s per test on iOS (12.8 s / 8 launches), estimated.
- Proposed fix: accept `OpenOptions` in `test.use({ launch: { wait: "quiet", args } })` (or a `launchWait` option) and pass it at `attempt.ts:282`. In dev mode, warn when a body or `beforeEach` calls `app.open` while `launch` is `"fresh"`. Touch `runner/scope.ts`, `runner/attempt.ts`, `runner/fixtures.types.ts`. Additive (`UseOptions` widening).
- Effort: S
- Risk: low
- How to verify: `runner/fixtures/launch.e2e.ts` case with `launch: { wait: "quiet" }`, asserting one `launch` + one `settle` driver call.
- Confidence: high
- Verified by: read; grep of the suites.

## Known items

- **K1**: known-extended (08-7). Inside my files, the untraced residue is the lazy driver open in the first test of each process, plus JS between calls. Every other runner phase is a step (`app.open`, fixtures, hooks, cleanup) or goes through the traced driver. `beforeAll`/`afterAll` time is outside every test (08-4).
- **K5**: related (08-2). Overlapping attempts make the result order, and so the blame, unreliable.
- **K14**: known-extended (08-6, 08-3). The runner has no per-attempt reset of the devtools rings or of the attempt dir. The "no results.jsonl" path is also hit by a failing `beforeAll` (08-4).
- **K15**: known-extended (08-10). The runner's own launch can't wait at all.
- **K18**: not changed by the runner. It adds no settle after the launch.

## Gaps I could not assess here

- The real cost of `openIosDriver` / `openAndroidDriver` per spec process, to size 08-7. On a leased sim, run `WARDEN_E2E_DEBUG=1 warden e2e example --platform ios` and read the timed exec lines from open. On Android, time from process start to the first `driver.*` span.
- Whether the iOS helper and `warden-uiad` serialise a capture's screenshot and snapshot (08-5). On a sim, time `captureFailure` with the calls serial against `Promise.allSettled`, using a spec that fails right after a navigation.
- How an abandoned in-flight driver call (08-1/08-5) interacts with the next request on the simd socket and on uiad. Agents 02/04 own the wire.

## Owned files not read

none. All files in `runner/fixtures/**` were listed; `timeout.e2e.ts`, `retry.e2e.ts`, `preload.ts` and `fake-setup.ts` were read, and the rest were covered through `runner.test.ts`.

## Questions for the user

- Should a retry keep the failed attempt's artifacts (one subdir per attempt), or replace them (clear the dir)? That decides the shape of the 08-3 fix and whether `TestResult` gains an attempt number.

## Files read

- packages/e2e/src/runner/{attempt,test,scope,trace,span,step,results,failure,artifacts,callsite,fixtures.types}.ts
- packages/e2e/src/runner/runner.test.ts (harness, deadline/retry/multi-file cases)
- packages/e2e/src/runner/fixtures/{timeout,retry}.e2e.ts, fixtures/preload.ts, fixtures/fake-setup.ts
- packages/e2e/src/{session,preload,env,fixtures,fixture-session,traced-device,index,version}.ts
- context: packages/e2e/src/{app,device}.ts (signal reads), driver/unwrap.ts, driver/open.ts, driver/ios/ios-driver.ts (open), driver/observation-cache.ts (header), devtools/facet.ts, devtools/console.ts (API), screen/context.ts / poll.ts (signal reads)
- apps/cli/src/e2e/bun-runner.ts; packages/e2e-bench/suites/warden/{sign-in.e2e.ts,helpers/flows.ts}
- docs/audit/BRIEF.md, ASSIGN-08.md; packages/e2e/AGENTS.md § Tracing; docs/plans/wdn-perf.md (claims grep); docs/plans/wdn-e2e.md:460-470; docs/bench/{ios,android}-2026-10-16-perf.md (untraced sections)
