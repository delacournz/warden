# 03 · ios-driver-ts

Auditor 03. Commit `dfcc68b`. HEAD is `d6629f7`, and `git diff dfcc68b HEAD -- packages apps` is empty, so the line numbers below hold for both. Owned tests were run once: `bun test src/driver/ios src/driver/{open,traced-driver,unwrap,span-detail,refs,settle,typing,errors,driver.testing}.test.ts`, 291 pass, 0 fail.

## Top 5 by impact

- **03-1**: In socket mode the client never reconnects after the daemon connection drops. `E_HELPER_CRASHED` is retryable, so every later look polls for the full 30 s action timeout. One daemon death fails the rest of the spec process.
- **03-4**: Guest recycling (11 of 24 launches, +0.51 s each, measured) runs inside `rebind`, after `simctl launch` returns. It could overlap the launch. Estimated ≤ 1.9 s per 8-test iOS rep.
- **03-2**: A live socket that sends no `ready` costs 15 s (`DEFAULT_READY_TIMEOUT_MS`). The driver then spawns a second stdio helper next to the live daemon, and two quiescence streams stall each other (settle ~2.5 s instead of ~0.26 s).
- **03-3**: Bridge-stale recovery in socket mode sends `shutdown` to the shared daemon. The rest of the run loses the warm helper: every later spec process pays a cold stdio start.
- **03-6**: An aborted driver call (test deadline) is never cancelled in the helper. An in-flight `typeText`, `longPress` or `swipe` keeps sending HID events into the next attempt or test.

## Findings

### 03-1 Socket client never recovers from a lost daemon; retryable `E_HELPER_CRASHED` burns every action timeout
- Category: robustness
- Severity: P1
- Known?: new
- Evidence:
  - `connectSimd` sets `maxRespawns: 0` (`packages/e2e/src/driver/ios/simd-client.ts:421@dfcc68b`). After the connection closes, `ensureSession` returns `lastCrash` immediately on every call (`simd-client.ts:271-279@dfcc68b`). `simd-client.test.ts:423-440@dfcc68b` pins this behaviour.
  - That error is `E_HELPER_CRASHED`, which `driverError` marks `retryable: true` (`packages/e2e/src/driver/errors.ts:4-10,20@dfcc68b`).
  - The driver restarts the helper only after two `E_AX_UNAVAILABLE` in a row (`packages/e2e/src/driver/ios/ios-driver.ts:213-231@dfcc68b`). It never does so on `E_HELPER_CRASHED`, so `swap.restart` (which would reconnect, or fall back to a stdio spawn, `ios-driver.ts:502-516@dfcc68b`) is never reached.
  - Locator reads retry retryable snapshot errors until the action timeout (`packages/e2e/src/screen/context.ts:150-161@dfcc68b`, owned by 07). The default action timeout is 30 s (`packages/e2e/src/env.ts:29@dfcc68b`).
  - Stdio mode has the same dead end once its one respawn is spent on a helper that dies before answering (`simd-client.ts:274-279@dfcc68b`).
- Impact: estimated, iOS. After a daemon crash (or `warden ui close` / `release --shutdown` from another shell mid-run), each remaining look waits ~30 s and then fails. Every later test in that spec process fails: 8 tests × ≥ 30 s ≈ ≥ 4 min of guaranteed failures per rep. Today the recovery would cost one reconnect (a stdio spawn is cold: 544–726 ms, from `docs/bench/ios-2026-10-16-perf.md` "Read with care").
- Proposed fix: in `ios-driver.ts`, treat `E_HELPER_CRASHED` from any request like the stale-bridge case. Call `swap.restart(generation)` once. Retry reads (`snapshot`, `health`, `alertButtons`, `frontmost`, `settle`) once, and return input ops' errors unchanged, since the input may have landed. `doRestart`'s `shutdown` to a dead client returns at once. Optionally give `connectSimd` `maxRespawns: 1` (a reconnect, not a spawn). The change is additive. Files: `ios-driver.ts`, `ios-session.ts`, plus tests.
- Effort: S
- Risk: low. A real crash during an input op still surfaces. Verifying needs a device (`smoke.ts --kill-helper` under `WARDEN_SIMD_SOCKET`).
- How to verify: write an `ios-driver.test.ts` case where a socket daemon ends its connections mid-run and the next `snapshot` succeeds through a stdio fake (pattern at `ios-driver.test.ts:1076`). On a device, run `smoke.ts --kill-helper` with the socket set.
- Confidence: high
- Verified by: traced the path from `connectSimd` through `ensureSession` and `ios-driver.snapshot` to `Runtime.observe`

### 03-2 A silent socket waits 15 s, then a second helper is started next to the live daemon
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `trySocket` calls `connectSimd` without `readyTimeoutMs` (`ios-driver.ts:493-500@dfcc68b`), so it gets `DEFAULT_READY_TIMEOUT_MS = 15_000` (`simd-client.ts:72,106@dfcc68b`). The CLI's own probe of the same socket uses 2000 ms (`apps/cli/src/agent-ui/helper.ts:158@dfcc68b`).
  - Any failure, including a ready timeout or a protocol mismatch from a daemon that is alive, falls through to `spawnSimd` (`ios-driver.ts:502-516@dfcc68b`).
  - `packages/e2e/AGENTS.md` (§ Quiescence stream) measures a second helper on the same sim: `settle` falls back to `via:"snapshot"`, ~2.5 s instead of ~260 ms, in both helpers, for as long as both are open.
  - The daemon sends each connection's `ready` from its accept path (`native/ios/Sources/warden-simd/Server/SocketServer.swift:301-303@dfcc68b`). A missing `ready` therefore means a wedged or overloaded daemon, not a dead one.
- Impact: estimated, iOS, only when the daemon is alive but not answering. 15 s per spec-process open, plus ~2.2 s × every settle in that process (8 `app.open` settles per rep alone ≈ +18 s per rep). The daemon's other clients are also slowed.
- Proposed fix: use a socket `readyTimeoutMs` of 2–3 s. Fall back to stdio only when the connect itself fails (ENOENT / ECONNREFUSED, meaning nobody is listening). A connected-but-silent daemon or a protocol mismatch should return `E_HELPER_CRASHED` with the hint `warden ui close --udid <udid>`. The change is additive, in `ios-driver.ts`, plus a `simd-transport.ts` error that tells "connect failed" from "connected".
- Effort: S
- Risk: low. A user who relied on the silent fallback now gets an error. That is the correct outcome, because the fallback degrades both helpers.
- How to verify: a unit test with a `Bun.listen` socket that accepts and never writes, asserting no spawn and a fast error. On a device, `kill -STOP` the daemon and open a driver.
- Confidence: med
- Verified by: read `trySocket` / `connect` / `createSimdClient`, and checked the Swift accept path

### 03-3 Bridge-stale recovery shuts down the shared daemon; later spec processes start cold
- Category: perf-latency
- Severity: P2
- Known?: new (relates to K7 and K11)
- Evidence:
  - The second consecutive `E_AX_UNAVAILABLE` calls `swap.restart` (`ios-driver.ts:224-230@dfcc68b`).
  - `doRestart` sends `shutdown` to the current client, which is the shared socket daemon (comment: "A shared socket daemon only stops if asked", `packages/e2e/src/driver/ios/ios-session.ts:57-60@dfcc68b`).
  - The daemon unlinks its socket on `shutdown` (`SocketServer.swift:261-272@dfcc68b`). `reopen` then finds no socket and spawns a private stdio helper (`ios-driver.ts:502-516@dfcc68b`).
  - Every later spec process of the run still receives `WARDEN_SIMD_SOCKET` (`apps/cli/src/commands/batch.ts:667-669@dfcc68b`). Each one fails the connect and spawns its own helper.
- Impact: estimated, iOS. Per later spec process: a cold start of 544–726 ms (bench doc), plus ~0.5 s to open the stream and a guest start, instead of a ~182 ms warm attach. It also leaves the `warden ui` state record pointing at a dead helper until the next `ensureHelper`.
- Proposed fix: replace `shutdown` with a daemon-side "recycle the AX guests and restart the stream" op. The helper already does this inside `rebind` (`RebindPrelude`, `native/ios/Sources/warden-simd/Ops/Settle.swift:788@dfcc68b`). The TS side then reconnects to the same socket. Keep `shutdown` only as the fallback when the recycle fails. The wire change is additive (a new op). Files: `ios-session.ts` and `ios-driver.ts` here, plus a Swift op (owned by 01/02).
- Effort: M
- Risk: med. It needs a device to confirm that a recycle clears the stale bridge as well as a process restart does.
- How to verify: on a device, run `smoke.ts --kill-bridge` with `WARDEN_SIMD_SOCKET` set, then check that the socket file still exists and that a second process attaches warm.
- Confidence: med
- Verified by: traced the path from `ios-driver.snapshot` through `swappableClient.doRestart`, `SocketServer.stop` and `connect`

### 03-4 Guest recycle sits on the launch critical path, after `simctl launch`
- Category: perf-latency
- Severity: P2
- Known?: known-extended K7
- Evidence:
  - `app.launch` is strictly serial: `simctl.launch` (one `xcrun` spawn, `LAUNCH_MS` 30 s), then `rebind` (`ios-driver.ts:465-472,268-287@dfcc68b`).
  - The helper's `rebind` first runs `RebindPrelude`, which ends aged guests and restarts the stream (`Settle.swift:788,889@dfcc68b`). Only then does it wait for the bind.
  - Measured in `docs/plans/wdn-perf.md:102-106`: 11 of 24 launches recycled, and a recycle costs +0.51 s (1610 vs 1097 ms).
  - Nothing in the recycle depends on the new process. It could run while `simctl launch` terminates the old process and spawns the new one.
- Impact: estimated, iOS. 11/24 × 8 = 3.7 recycling launches per rep. The saving is min(0.51 s, simctl launch time) each, so ≤ 3.7 × 0.51 ≈ 1.9 s per rep, ≈ 0.24 s per test. That is about 3 % of the 60.8 s warm suite. The real figure depends on how long `simctl launch` takes, which nothing records.
- Proposed fix: send a `prepareLaunch` (or `rebind{phase:"recycle"}`) request without awaiting it, concurrently with `simctl.launch`. Then send `rebind` with recycling skipped. Alternatively, do the age check on a helper timer so the guests are never old at launch time. The wire change is additive. Files: `ios-driver.ts`, plus `Settle.swift` (owned by 01).
- Effort: M
- Risk: med. A stream restarted on the outgoing app has to follow the new process. PERF-1.2 measured that a restart takes 1.15–1.3 s to its first state against 0.6–0.7 s for a plain follow (`wdn-perf.md:110`), so on-device timing decides whether this wins.
- How to verify: add `simctlMs` to the `driver.app.launch` span (see 03-10). Re-run the iOS bench and compare `rebindMs` / launch medians on `rebindRecycled` launches.
- Confidence: med
- Verified by: read `ios-driver.ts` launch/rebind, `Settle.swift` RebindPrelude and the PERF-1.2b table

### 03-5 `typeText` timeout ignores the helper's pacing env and has no per-key slack; overflow types partial text
- Category: robustness
- Severity: P2
- Known?: new (touches K9: it does not lower pacing)
- Evidence:
  - The budget is `10_000 + 70·chars + 300·repeats` (`packages/e2e/src/driver/ios/type-budget.ts:2-13@dfcc68b`). 70 ms is exactly the default hold 40 + pace 30, and 300 ms is exactly the default repeat gap.
  - The helper reads `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS` / `WARDEN_SIMD_REPEAT_GAP_MS` (0..1000 each) from its own env (`native/ios/Sources/warden-simd/Ops/Keyboard.swift:90-98@dfcc68b`). It also adds shift down/up events (`Keyboard.swift:116-118@dfcc68b`). The TS side never reads those env vars and never sends `paceMs` / `holdMs` (`ios-driver.ts:233-234@dfcc68b`).
  - The client's timer and the envelope `timeoutMs` are the same number (`simd-client.ts:316-330@dfcc68b`), and `typeText` is not self-timed (`native/ios/Sources/warden-simd/Server/Dispatcher.swift:17,35-39@dfcc68b`). Both sides give up at once and leave a prefix typed.
- Impact: estimated, iOS. With hold = pace = 100 ms (the direction a loaded host needs, per K9), the real cost is ≥ 200 ms/char against a 70 ms/char budget. Any text longer than 10 000 / (200 − 70) ≈ 77 chars then fails with a retryable `E_TIMEOUT` and a half-typed field. With the defaults, only per-key HID overhead eats into the 10 s base, so the default path is not at risk for bench-length texts (17 calls, 18.7 s per rep).
- Proposed fix: read the three env vars in `type-budget.ts`, using the same names and defaults, and send them explicitly as `paceMs` / `holdMs` / `repeatGapMs` so both sides agree. Budget `(hold + pace + 15) · n + repeatGap · repeats + shiftToggles · hold + 10 s`. The change is additive. Files: `type-budget.ts`, `ios-driver.ts`.
- Effort: S
- Risk: low. A longer timeout only delays the failure of a genuinely hung helper.
- How to verify: a `type-budget.test.ts` case with the env set. On a device, type a 120-char string with `WARDEN_SIMD_HOLD_MS=100 WARDEN_SIMD_PACE_MS=100`.
- Confidence: high
- Verified by: read `type-budget.ts`, `ios-driver.ts`, `Keyboard.swift` and `Dispatcher.swift`

### 03-6 Aborted driver calls keep running in the helper (no cancel)
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence:
  - `settled()` races the call against the attempt's `AbortSignal` and throws `TIMEOUT` on abort. The underlying `client.request` keeps its pending entry and timer (`packages/e2e/src/driver/unwrap.ts:39-56@dfcc68b`, `simd-client.ts:318-342@dfcc68b`).
  - There is no `cancel` op on the wire (`simd-protocol.ts` op table `:363-373@dfcc68b`; the Swift dispatcher has none).
  - The helper finishes the op. A `typeText` budget can be 10 s+, a `longPress` or `swipe` has its own duration, and a `rebind` takes up to 3 s.
  - The next attempt's `app.open` (`packages/e2e/src/app.ts:77@dfcc68b`, owned by 09) runs `simctl launch` while those HID events still land.
- Impact: estimated, iOS, only on attempts that end mid-input (test deadline). Keys from the old attempt land in the relaunching app or in SpringBoard, which can turn a retry red. No bench number exists (retries = 0 there).
- Proposed fix: TS-only first step: track in-flight input requests in `createSimdClient` and expose `drain(timeoutMs)`. The session (08) awaits it before the next attempt's first driver call. Second step: a `cancel{id}` op that cancels the Swift task (`withTimeout` already cancels on its own deadline, and `HIDGate` waiters leave on cancel). The second step is an additive wire change.
- Effort: M
- Risk: low for `drain` (it only waits). `cancel` needs a device check that a cancelled composite HID event stops cleanly.
- How to verify: a unit test where an aborted `typeText` is followed by an `app.launch`, asserting the launch waits for the drain. On a device, set a 2 s test timeout over a 60-char `fill`.
- Confidence: med
- Verified by: traced the path from `unwrap.settled` through `simd-client.request` to `Dispatcher.handle`

### 03-7 simctl timeouts surface as non-retryable `E_IO` with no "timed out" in the message
- Category: robustness
- Severity: P2
- Known?: known-extended K16
- Evidence:
  - `createSimctl.run` maps any non-zero exit through `simctlFailure` (`packages/e2e/src/driver/ios/simctl.ts:213-218,152-169@dfcc68b`).
  - `bunExec` passes `timeout` to `Bun.spawn` and returns only `{exitCode, stdout, stderr}`, with no timed-out flag (`packages/core/src/exec.ts:17-36@dfcc68b`, owned by 18). A launch killed at `LAUNCH_MS` 30 s (`simctl.ts:19@dfcc68b`) therefore becomes `E_IO`, which is `retryable: false` and maps to `ACTION_FAILED`, with a message like "`xcrun simctl launch …` exited <signal code>".
  - The test then fails as an app problem, not as a timeout. Nothing retries the launch.
- Impact: measured once in K16 (> 30 s). Estimated: when it happens, the test fails after 30 s with a misleading code. A retry of a hung `simctl launch` usually succeeds.
- Proposed fix: time the call in `run()` (the clock is already injected through the driver) or add `timedOut` to `ExecResult` (core, owned by 18). Map a timeout to `E_TIMEOUT` (retryable) with `detail.timeoutMs`. For `launch`, retry once after `simctl terminate`. The change is additive.
- Effort: S
- Risk: low.
- How to verify: a `simctl.test.ts` case with a fake exec that resolves after the timeout and exits 143, asserting `E_TIMEOUT`.
- Confidence: high
- Verified by: read `simctl.ts` and `core/src/exec.ts`

### 03-8 Every `FBSOpenApplicationServiceErrorDomain` failure on launch/openurl is classed "app unavailable"
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `simctlFailure` maps the domain name, whatever the code, to `E_APP_UNAVAILABLE` for app commands (`simctl.ts:162-167@dfcc68b`). The test uses "error 4", the not-installed case (`simctl.test.ts:95-117@dfcc68b`).
  - The same domain also carries transient denials (code 1, "request was denied by service delegate (SBMainWorkspace)", seen right after a terminate or while SpringBoard is busy).
  - `E_APP_UNAVAILABLE` is not retryable and maps to `DRIVER` (`unwrap.ts:7-15,17-21@dfcc68b`).
- Impact: estimated, iOS. A transient launch denial fails the test with "app unavailable" instead of being retried (a retry costs ~0.3–1 s).
- Proposed fix: map only "not installed | found nothing | No such app | error 4" to `E_APP_UNAVAILABLE`. Map other FBS codes to `E_IO` with `retryable: true`, and retry `launch` / `openUrl` once after 300 ms. The change is additive, in `simctl.ts`.
- Effort: S
- Risk: low. It needs on-device stderr samples of the real code 1 text to pin the regex.
- How to verify: collect stderr from a forced-denial launch on a device (launch while the sim is locked: `xcrun simctl spawn <udid> notifyutil -p com.apple.springboard.lockcomplete`, then launch). Add both texts as `simctl.test.ts` cases.
- Confidence: low
- Verified by: read

### 03-9 `toE2eError` drops `retryable` and `detail`
- Category: dx
- Severity: P3
- Known?: new
- Evidence:
  - `toE2eError` keeps only the code and message (`unwrap.ts:24-26@dfcc68b`); `driverFailure` does the same (`screen/context.ts:218-220@dfcc68b`, owned by 07). The `detail` that is lost includes simctl `{argv, exitCode}` (`simctl.ts:155@dfcc68b`), timeout `{op, timeoutMs}` (`simd-client.ts:323-325@dfcc68b`), typing `rest` and wire `wireCode` (`simd-protocol.ts:419-428@dfcc68b`).
  - `results.jsonl` and the failure text therefore cannot say which op timed out after how long, or which wire code was unknown.
- Impact: n/a (diagnosis time).
- Proposed fix: add `cause: DriverError` to `E2eError` (or a `detail` field) and print `detail` scalars in the failure excerpt. The change is additive.
- Effort: S
- Risk: low. Watch for `typeText` text leaking into `detail.rest`: redact it the way spans never record arguments.
- How to verify: a unit test on `toE2eError` that preserves `cause`.
- Confidence: high
- Verified by: read

### 03-10 No record of where `app.launch` time goes; the smoke script cannot measure it or socket recovery
- Category: test-gap
- Severity: P3
- Known?: known-extended K16
- Evidence:
  - The `driver.app.launch` span carries `rebind` / `rebindMs` / `rebindRestarts` / `rebindRecycled` (`ios-driver.ts:281-285@dfcc68b`), but not the `simctl launch` time. A K16 30 s launch and a slow bind look the same from outside.
  - `smoke.ts` times only whole steps (`native/scripts/smoke.ts:310@dfcc68b`).
  - `--kill-helper` checks stdio respawn only (`smoke.ts:240-255@dfcc68b`). Under `WARDEN_SIMD_SOCKET` it kills the daemon and, given 03-1, can never pass.
  - The `simd-client` tests use real timers and real `bun` subprocesses (`simd-client.test.ts:25-29,137-145,429-430@dfcc68b`), with no injected clock. That is fine today (2.3 s for 291 tests here) but timing-dependent under load (K13).
- Impact: n/a. It blocks the verification of 03-4 and K16.
- Proposed fix: `noteSpanDetail("simctlMs", …)` around `simctl.launch` in `ios-driver.ts`. Make the smoke print `simctlMs` / `rebindMs` and add a `--socket` variant of `--kill-helper` that expects a reconnect. The change is additive.
- Effort: S
- Risk: low.
- How to verify: an `ios-driver.test.ts` span-detail assertion. On a device, run `smoke.ts --udid <udid>` and read the launch line.
- Confidence: high
- Verified by: read

### 03-11 Client timer equals the helper's envelope timeout, so the helper's own timeout answer is always dropped
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - `request` sends `timeoutMs` and arms a client timer with the same value (`simd-client.ts:316-330@dfcc68b`). The helper races the same number (`Dispatcher.swift:35-39@dfcc68b`).
  - The client timer always fires first. The helper's `E_TIMEOUT` (whose message names the helper-side op) arrives as "response for unknown id" (`simd-client.ts:147-150@dfcc68b`), and the client cannot tell "the helper gave up" from "the helper never answered".
  - The request spreads `params` after `timeoutMs` (`{ timeoutMs, ...params, id, op }`, line 330), so a caller param named `timeoutMs` silently overrides the envelope while the client timer keeps `opts.timeoutMs`.
- Impact: n/a (diagnosis); no latency.
- Proposed fix: send `timeoutMs: clientTimeout − 250` (minimum 1). Put `timeoutMs` after `...params`, or reject a `timeoutMs` param. The change is additive.
- Effort: S
- Risk: low.
- How to verify: `simd-client.test.ts`: a helper that answers its own `E_TIMEOUT` at `timeoutMs` reaches the caller.
- Confidence: high
- Verified by: read

## Known items

- K7: known-extended (03-4, 03-3). Recycling runs inside `rebind` on the launch critical path. Socket-mode stale-bridge recovery kills the daemon instead of recycling guests.
- K9: touched by 03-5 without lowering pacing. The TS budget ignores the pacing env overrides that are the remedy for a loaded host.
- K11: touched by 03-3. After a socket-mode restart, every later spec process pays the cold start that K11 measures.
- K13: touched by 03-10. The client tests rely on real timers and subprocesses.
- K15: known-confirmed, for the driver side. `app.launch` clears the `launchedBundle` gate as soon as `rebind` answers `bound` (`ios-driver.ts:468-469@dfcc68b`). The settle in `app.open({wait:"quiet"})` then judges the app's own run loop with no further condition, so an RN app idle while its JS loads reads as quiet before the welcome screen. The policy fix belongs to 09 (`app.ts:58-65`).
- K16: known-extended (03-7, 03-10). A timeout maps to non-retryable `E_IO` with no "timed out", and the span does not split simctl time from rebind time.
- K18: known-confirmed. `settle{bundleId}` is sent only while the gate is set, that is, when `rebind` did not bind (`ios-driver.ts:294-302@dfcc68b`).
- Plan claim "hand-written wire validator (no zod on snapshots)" (`docs/plans/wdn-perf.md:50`): confirmed with a caveat. Element trees go through the hand-written `isWireElement` (`simd-protocol.ts:152-159@dfcc68b`, via `z.custom` at `:265`). Each reply still goes through two small zod parses: the `responseSchema` envelope (`:207-210`) and the top-level `snapshotDataSchema` (`:260-272`, called at `simd-client.ts:288-302`). `alertButtons` and `elementAtPoint` still run the full recursive zod `wireElementSchema` (`:323-330,274`). At 170 snapshots per rep and the module's own measurement (0.05 ms warm per tree), the remaining zod cost is estimated at a few ms per rep. Not worth a finding.
- Other hotspots checked and found cheap (no finding): the `traceDriver` Proxy plus `AsyncLocalStorage.run` cost one Map lookup, one ALS frame and one span object per call, and no span is created outside an attempt (`traced-driver.ts:51-53@dfcc68b`). The NDJSON splitter re-splits the buffered tail per chunk, which is negligible at ~18 KB snapshots. There is one `setTimeout` per request, cleared on answer, and the pending map entry is removed on timeout. `open.ts` / `openIosDriver` run the helper connect and the AutomationEnabled probe in parallel (`ios-driver.ts:536@dfcc68b`; the AutomationEnabled ordering finding is 16's). `capabilities` is built once per driver. `pressKeys` on iOS is one RPC per Backspace, but pacing (70 ms/key) dominates the RPC cost, and `selectAll` covers the plain-text case. `locate-helper` costs at most three `existsSync` calls and one `realpathSync`, run twice on the stdio path (`ios-driver.ts:530,505@dfcc68b`), which is microseconds.

## Gaps I could not assess here

- The split between `simctl launch` and `rebind` inside the 1.6 s average launch (8 launches = 12.8 s per rep). Needs 03-10's `simctlMs`, or `WARDEN_E2E_DEBUG=1 bun test …` on the bench suite, which logs `[ios] exec xcrun simctl launch N ms` and `[ios] op rebind N ms` per launch.
- Whether a pre-launch guest recycle (03-4) binds as fast as the in-`rebind` one. Needs an on-device A/B with `WARDEN_SIMD_GUEST_MAX_AGE_S=12`, 3 reps, comparing launch medians.
- The FBS denial text and code (03-8). Needs a forced denial on a booted sim, with stderr captured from `xcrun simctl launch`.
- Stdio `close()`: whether the helper's teardown finishes inside the 1.5 s grace or gets SIGTERM'd, leaving guests behind. Check with `time` on `driver.close()` in `smoke.ts`, then `pgrep -f SimulatorFrameworkBridge-iOS`.
- 03-1 / 03-3 recovery on a device: run `smoke.ts --kill-helper` and `--kill-bridge` with `WARDEN_SIMD_SOCKET` set.

## Owned files not read

- `packages/e2e/src/driver/driver.testing.ts` was read only in part (capability surface and settle/selectAll/alertOn/isFrontmost stubs). `driver.testing.test.ts`, `refs.test.ts`, `typing.test.ts`, `open.test.ts`, `normalize.test.ts`, `wire-element.test.ts`, `locate-helper.test.ts`, `type-budget.test.ts`, `span-detail.test.ts`, `unwrap.test.ts`, `errors.test.ts` and `traced-driver.test.ts` were run, not read line by line. `ios-driver.test.ts` was grepped (socket, restart, rebind, settle cases), not read whole. `driver.types.ts` was read only where cited.

## Questions for the user

- Is a daemon dying mid-run (crash, `warden ui close` from another shell, idle exit while a spec is between processes) something you have seen? It decides whether 03-1 stays P1 or drops to P2. The fix is cheap either way.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-03.md` (and the owned-files headers of the other `ASSIGN-*.md`)
- `packages/e2e/src/driver/ios/{simd-protocol,simd-transport,simd-client,ios-driver,ios-session,locate-helper,type-budget,normalize,simctl,simd.testing,exec.testing}.ts`
- `packages/e2e/src/driver/{open,traced-driver,span-detail,unwrap,errors,typing,settle,alerts,refs}.ts`; parts of `driver.testing.ts`, `simd-client.test.ts`, `ios-driver.test.ts`, `simctl.test.ts`
- `packages/e2e/native/scripts/{smoke,screen-cost}.ts`
- Context (not owned): `packages/e2e/src/{app.ts,runner/span.ts,screen/context.ts (observe, drive),screen/field.ts (clear path),env.ts:29}`, `packages/core/src/exec.ts`, `apps/cli/src/e2e/warm-connect.ts`, `apps/cli/src/commands/batch.ts:660-670`, `apps/cli/src/agent-ui/helper.ts:158`
- Swift context (not owned): `Server/Dispatcher.swift`, `Server/SocketServer.swift:245-310`, `Device/Session.swift:120-160`, `Ops/Keyboard.swift:85-140`, `Ops/Input.swift:135-180`, grep of `Ops/Settle.swift`
- `docs/bench/ios-2026-10-16-perf.md`, `docs/plans/wdn-perf.md:36-112`, `packages/e2e/AGENTS.md` (via CLAUDE.md)
