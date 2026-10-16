# 07 · screen-actions-poll

Scope: `packages/e2e/src/screen/{actions,field,poll,context}.ts`, `poll.testing.ts`, their tests, `expect/{expect,matchers}.ts` and `matchers.test.ts`. I also traced the callers in `screen/locator.ts`, which agent 06 owns: `fill`/`clear`/`confirm`, `actionable`, `tap({until})`.

Summary of the common case. An iOS `fill` into an empty sign-in field (RN reports the placeholder as the value, so it reads as `text`) costs 1 fresh snapshot (`actionable`, `reuse:false`), 1 focus tap, 1 `selectAll`, 1 `typeText` and 2 hit-tests 50 ms apart. That matches the measured ~0.3 s overhead beyond typing (`docs/plans/wdn-perf.md:157,679`: snapshot ~85 + select-all ~90 + 2 confirms ~65 ms). The common path is close to its floor. The cost and risk sit in the failure and edge paths: the retry, abort, secure fields, off-screen focus, and the `tap({until})` re-send. `poll.ts` matches PERF-2.3: 100 ms for 1 s, then 250 ms, no sleep past the deadline, the gap measured on the clock (`poll.ts:35-39,81-95`). A step that starts at the deadline can still overshoot it by one step's duration. That is inherent, and it is documented.

## Top 5 by impact

- 07-3: `tap({until})` re-sends blind after a fixed 4 s window. A press that landed late is pressed again, and a dropped press costs ~4 s where ~1 s would do.
- 07-1: no frame-stability check before a tap. A single fresh snapshot taken mid-slide still mis-taps.
- 07-2: assert-then-tap on iOS pays a full ~76 ms snapshot where a ~10 ms hit-test against the kept snapshot would prove the target is still in place (est. ~1.6 s/rep).
- 07-4: after the attempt deadline aborts, `fill`'s confirm loop keeps running with zero-length sleeps and hammers the device for up to ~1 s, alongside failure capture and cleanup.
- 07-6: secure fields are never read back after `fill`, though the dot count that would verify them is already parsed.

## Findings

### 07-1 Actions tap where one snapshot says the element is, with no stability check

- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence: `actionable` (`packages/e2e/src/screen/locator.ts:386-411@dfcc68b`) polls `tryObserve({ reuse: false })` (`:392`). It returns on the first poll where the match is visible, enabled and has its tap point on screen (`blockedReason`, `:791-798`). It never compares the frame with an earlier look. The bench explains the `reuse:false` rule this way: "an assertion's snapshot can be of a screen still sliding in, which mis-tapped before that rule" (`docs/bench/ios-2026-10-16-perf.md:138`). A fresh snapshot can also be taken mid-slide. The rule narrows the window by the snapshot's age (≤ 150 ms, `driver/observation-cache.ts:17`) but does not close it. `tapPointOf` (`screen/actions.ts:30-34@dfcc68b`) then taps that frame's centre.
- Impact: estimated. Rare per tap (0 re-sends in 62 taps/rep in the idiomatic runs), but each mis-tap is a hard failure or a 4 s `until` re-send (07-3). Both platforms; the window is larger on iOS, where navigation animates ~350 ms.
- Proposed fix: Playwright's "stable" rule. Tap only when the target's frame is equal in two consecutive looks. When the observation cache still holds a snapshot of the same generation, compare against it: the fresh snapshot is the second look and costs nothing extra. Otherwise take one more snapshot only when the first look came less than ~300 ms after the last input. Files: `screen/locator.ts` (`actionable`), plus a peek accessor in `driver/observation-cache.ts`. Additive.
- Effort: M
- Risk: med. An element that animates forever (a spinner-wrapped button) would wait. Cap it with "stable or 2 extra looks". Verifying the mis-tap rate needs a device.
- How to verify: FakeDriver test where the frame moves between looks 1 and 2: the tap goes to the second frame. Count snapshots per rep with the iOS bench, which should stay at ~170.
- Confidence: med
- Verified by: traced path from `Locator.tap` → `tapOnce` → `actionable` → `tryObserve` → `driver.tap`

### 07-2 Assert-then-tap takes a second full snapshot on iOS where a hit-test would do

- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence: every `actionable` look is `reuse:false` (`screen/locator.ts:392@dfcc68b`), so a tap right after a passing `expect` always reads the device again. The bench measured this: "assert-then-tap is two snapshots in both suites" (`docs/bench/ios-2026-10-16-perf.md:138`). An iOS snapshot averages 13.0 s / 170 = 76 ms per rep (`ios-2026-10-16-perf.md:141`). `hitTestField` (`screen/field.ts:89-99@dfcc68b`) shows the cheaper primitive: `driver.elementAtPoint`, ~10 ms on iOS.
- Impact: estimated. (76 − 10) ms × ~25 assert-then-tap pairs per rep (of 62 taps; the pair count is my guess, not measured) ≈ 1.6 s/rep on iOS, ~200 ms/test. On Android, `elementAtPoint` is a whole uiad snapshot (`driver/android/android-driver.ts:351-359`), so there is no saving.
- Proposed fix: when the cache holds a same-generation snapshot younger than 150 ms with exactly one actionable match, hit-test that match's tap point. Tap without a snapshot only when the hit element has the same role, name/id and frame. This is also the two-look stability check of 07-1. Otherwise fall back to the fresh snapshot. Files: `screen/locator.ts` (`actionable`/`tapOnce`), `driver/observation-cache.ts` (peek). Additive.
- Effort: M
- Risk: med. The hit can return a child label, which falls back safely to a snapshot. The mis-tap regression the current rule was added for must be re-checked on a device.
- How to verify: unit test that assert-then-tap issues 1 snapshot + 1 `elementAtPoint` with an identical frame, and 2 snapshots when the frame moved. Re-run `bun run bench --frameworks warden` on iOS and compare the `driver.snapshot` count and the median.
- Confidence: med
- Verified by: read; traced `matchers.poll` → kept snapshot → `tapOnce` → `actionable`

### 07-3 `tap({until})` re-sends blind after a fixed window: a double press when the first one landed late, ~4 s lost when it was dropped

- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence: `tap` (`screen/locator.ts:437-452@dfcc68b`) runs `tapOnce`, then for each retry `arrivedWithin`, then `tapOnce` again (`:446-449`). Defaults: 2 retries, 4000 ms window, 250 ms fixed checks (`:718-720`; the checks use `intervalMs`, not the back-off, `:490`). Nothing tells "dropped" (the screen is unchanged) from "slow" (the screen reacted, e.g. a spinner or a disabled button, but `until` has not shown yet). In the slow case, a target that is still on screen is pressed again: a second submit, a toggled checkbox, a doubled navigation push. When the target has gone, `tapOnce` waits the whole action timeout (30 s, `env.ts:29`) for it and throws `LOCATOR_NOT_FOUND` although the first press worked. The pre-tap snapshot is already in hand (`found.observed.snapshot`, `:456-462`), and `driver/settle.ts:92` has `snapshotHash`.
- Impact: measured cost of one re-send: Android headline rep 3 re-sent one press, `settings` took 8.87 s and the median moved 2 s (`docs/bench/android-2026-10-16-perf.md:131`). Estimated saving with an "unchanged screen" rule: re-send at ~1 s instead of 4 s, so ~3 s per dropped press, ~1 s/rep at the observed 1 drop in 3 Android reps. The double-press risk has no measured rate.
- Proposed fix: hash the pre-tap snapshot. During `arrivedWithin` with a locator `until`, compare each check's snapshot hash with it. If the screen changed, do not re-send: keep waiting up to `windowMs` and return or throw. If it is unchanged for ≥ 2 consecutive checks after ~750 ms, re-send at once. For a function `until`, keep today's behaviour. Files: `screen/locator.ts`. This changes how often a press is re-sent, so `policy_change`; the API stays the same. Additive.
- Effort: M
- Risk: med. An app whose tree changes for unrelated reasons (a clock, a ticker) never looks "unchanged" and falls back to the full window (today's behaviour). Verifying the drop rate needs a device.
- How to verify: FakeDriver tests: (a) the screen changes but `until` is late, so there is no second press; (b) the screen is unchanged, so the re-send comes at ~1 s; (c) the target vanished, so there is no `LOCATOR_NOT_FOUND`. Then re-run the idiomatic Android bench 3 reps.
- Confidence: med
- Verified by: read `screen/locator.tap-until.test.ts` (68: "a press that never lands is sent 1 + retries times, then tap returns without throwing"); traced `tap` → `arrivedWithin` → `tapOnce`

### 07-4 After the attempt deadline, `fill`'s confirm loop spins with zero-length sleeps against the device

- Category: robustness
- Severity: P2
- Known?: new
- Evidence: `Locator.pause` is `clock.sleep(ms, signal)` (`screen/locator.ts:655@dfcc68b`), and `systemClock.sleep` resolves at once when the signal has aborted (`screen/poll.ts:12@dfcc68b`). `confirmFieldValue` (`screen/field.ts:59-86@dfcc68b`) never checks the signal. It loops `read` → `sleep(FIELD_POLL_MS)` until its own deadline: `VERIFY_MS` 1000, extended by 1000 for each change (`field.ts:80`), capped at `max(budget.remaining(), 500)` (`locator.ts:667`). The attempt deadline makes the runner give up on the step with `Promise.race` (`runner/step.ts:43`, `runner/attempt.ts:204`), but the orphaned `fill` keeps running. After the abort each loop pass is a hit-test (~10 ms iOS RPC, a whole uiad snapshot on Android) and, when that cannot tell, a full `tryObserve` (`locator.ts:678-691`), with no gap. That traffic runs at the same time as `captureFailureArtifacts` and cleanup (`attempt.ts:214,217`). The loop only ends at `actionable`'s `rt.poll`, which throws on abort (`context.ts:207`).
- Impact: estimated. On a fill that is mismatching when the test times out: ≤ ~1 s × ~100 RPCs/s on iOS (~40 snapshots/s on Android) against the same helper the failure screenshot and snapshot use. That costs failure-path time, and the artifacts can show a screen the orphan is still reading. No effect on passing runs.
- Proposed fix: give `ConfirmRequest` an optional `signal` and return `failed` when it aborts. Have `Locator.confirm` pass `rt.host.signal`. Files: `screen/field.ts`, `screen/locator.ts`; `apps/cli/src/agent-ui/actions.ts` needs no change. Additive.
- Effort: S
- Risk: low. No device is needed.
- How to verify: `field.test.ts` case with a clock whose `sleep` honours the signal (see 07-5): abort mid-confirm, and the read count stops growing.
- Confidence: high
- Verified by: traced path from `runStep` race → orphaned `Locator.fill` → `confirm` → `confirmFieldValue` → `pause`

### 07-5 `fakeClock().sleep` ignores the abort signal, unlike `systemClock`

- Category: test-gap
- Severity: P3
- Known?: new
- Evidence: `screen/poll.testing.ts:17-20@dfcc68b` pushes `ms` and advances time whatever the `signal`. `systemClock.sleep` returns at once on an aborted signal (`poll.ts:12-16`). Any code that relies on sleep for pacing after an abort, like 07-4, behaves differently in tests than on a device. The fake therefore cannot reproduce the spin.
- Impact: n/a. It hides bugs of the 07-4 kind.
- Proposed fix: make the fake honour `signal`: when aborted, record 0 and do not advance. Optionally add `abortedSleeps`. File: `screen/poll.testing.ts`. Additive.
- Effort: S
- Risk: low. Some tests may assert sleeps after an abort; update them.
- How to verify: `bun test packages/e2e/src/screen` stays green, and the 07-4 test fails before the fix.
- Confidence: high
- Verified by: read

### 07-6 Secure fields are never verified after `fill`, though their dots are already counted

- Category: correctness
- Severity: P2
- Known?: new
- Evidence: `fill` returns right after typing when `target.entry.secure` (`screen/locator.ts:526@dfcc68b`), and `clear` does the same (`:551`). `fieldContent`/`countDots` (`screen/actions.ts:112-136@dfcc68b`) already read a secure field's bullets (`•`/`●`) to decide how many Backspaces to press, so the length is readable. K9 records garbled typing under heavy host load (`wdn-perf.md:685`). A password that lost one key goes undetected, and the test fails later on a "wrong password" screen.
- Impact: estimated. 0 ms in the passing case if the confirm is two hit-tests (~65 ms measured for plain fields, `wdn-perf.md:157`), so +~65 ms per password fill. It turns a downstream assertion failure into a precise "fill did not take" with one counted retry. iOS and Android.
- Proposed fix: for a secure field, confirm `countDots(value) === graphemes(text)`. Also accept `graphemes(text) - 1` dots followed by one plain character, because iOS can briefly show the last typed character. Reuse `confirmFieldValue` by mapping the reading to a dot count. Files: `screen/locator.ts` (`confirm`), `screen/actions.ts` (export `countDots`), and the CLI `ui fill` path (`apps/cli/src/agent-ui/actions.ts:161`). Additive.
- Effort: S
- Risk: med. Fields whose AX value is not bullets (custom secure inputs) must fall back to "unverified" rather than fail. Needs a device check on both platforms of what the value shows right after typing.
- How to verify: on a device, `warden ui snapshot --json` right after `ui fill` into the sign-in password: the value is N bullets. Unit test: a dropped key gives a mismatch, then a counted retry.
- Confidence: med
- Verified by: read; traced `fill` → `focusClearType` → return

### 07-7 `fill`/`clear`/`type`/`press` tap a focus point that is never checked to be on screen

- Category: robustness
- Severity: P2
- Known?: new
- Evidence: these actions call `actionable` with `tapPointOnScreen: false` (`screen/locator.ts:518,538,548,561,571,583@dfcc68b`). `visible` only means the frame intersects the screen (`screen/nodes.ts:145`). `focusAndSelect` then taps `focusPoint` (`screen/field.ts:127@dfcc68b`; `screen/actions.ts:37-39`, 90% of the width at mid-height) without checking it. A field half below the screen edge, or behind the keyboard, gets its focus tap off screen or on a key. The keys then go to whichever field had focus, and the confirm sees a mismatch. The result is 2 attempts (~1 s confirm each + a counted retry) ending in "fill did not take", where a tap already throws "has its tap point outside the screen; use scrollTo()" (`locator.ts:795`).
- Impact: estimated. On the edge case: ~3 s wasted plus a misleading error, and text typed into the wrong field. Both platforms. No effect when the field is fully visible.
- Proposed fix: check `isOnScreen(focusPoint(frame), screen)` in `actionable` for the field actions (a new `focusPointOnScreen` spec flag). If the point is off screen, refuse with the scroll hint, or move the focus point to the visible part of the frame (`visibleRect`, `actions.ts:75-82`). Files: `screen/locator.ts`, `screen/actions.ts`. Additive, but a fill that "worked by luck" now fails clearly.
- Effort: S
- Risk: low. A keyboard-occluded field cannot be detected without the keyboard frame. That part needs a device.
- How to verify: FakeDriver test with a field whose centre y is greater than the screen height: `NOT_ACTIONABLE` with the scroll hint, and no keys sent.
- Confidence: med
- Verified by: traced `fill` → `actionable({tapPointOnScreen:false})` → `focusClearType` → `driver.tap(point)`

### 07-8 `.not` matchers always hold a full 1 s; the planned early end on `quiet` did not land, and its stated reason is stale

- Category: perf-latency
- Severity: P3
- Known?: claimed-fixed-not-landed (`docs/plans/wdn-perf.md:255`: "end early once a settle reports `quiet` and the condition holds")
- Evidence: `NEGATION_GRACE_MS = 1000` (`expect/matchers.ts:17@dfcc68b`). The hold is applied at `:290,305-318`. The comment at `:12-15` declines the plan item because Android settle would be "a second `uiautomator dump` (~1.9 s)". With `warden-uiad`, Android settle is `uiad.settle` over the accessibility stream (`driver/android/android-driver.ts:489-492`) and a snapshot is ~25 ms (`android-2026-10-16-perf.md` per-snapshot p50), so that reason no longer holds. iOS settles via stream in ~260 ms (`wdn-perf.md:681`).
- Impact: estimated. ~1000 − ~300 ≈ 700 ms per negated assertion on either platform. The bench suites use 0 `.not` matchers (`grep` of `packages/e2e-bench/suites/warden`, `apps/example/e2e`), so the bench saving is 0.
- Proposed fix: once the condition has held ≥ 1 poll, call `driver.settle({ quietMs: 250, timeoutMs: hold })` once. If it reports `quiet`, take one fresh poll and pass if the condition still holds. Update the comment. File: `expect/matchers.ts`. It changes timing users see (`policy_change`). Additive.
- Effort: S
- Risk: low. A screen that is quiet but about to change on a timer (a toast after 800 ms) passes earlier than today. Document it.
- How to verify: `matchers.test.ts`: with settle `quiet` the negation ends after settle + 1 poll, and without settle it still holds 1 s (existing test at `:224`).
- Confidence: high
- Verified by: read; ran `bun test packages/e2e/src/expect/matchers.test.ts`

### 07-9 The fill retry path waits a full second on a stable wrong value, then presses N+1 single-key RPCs on iOS

- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: on a mismatch, `confirmFieldValue` (`screen/field.ts:78-83@dfcc68b`) extends the deadline by `FIELD_PROGRESS_MS` (1000) on the first differing read, because `held` starts as `"(gone)"`. It then polls every ~60 ms until that deadline even when the value is stable: ~16 hit-tests. The retry (`clearMethodFor(2)` = `counted`, `locator.ts:769-771`) takes a new snapshot and calls `pressKeys` with N+1 Backspaces (`screen/actions.ts:143-153`). iOS has no `pressKeyRepeat` (only Android does, `android-driver.ts:396,576`), so that is N+1 `key` RPCs at ~78 ms each (`wdn-perf.md:38`). A held value of `previous + text` is the exact signature of a select-all that did not take, and it does not need a second of waiting.
- Impact: estimated, iOS, 15-char field: ~1.0 s wait + 0.085 snapshot + 16 × 0.078 ≈ 1.25 s Backspaces + ~1.1 s retype + 0.07 confirm ≈ 3.5 s per retried fill. Ending the wait when `held === previous + text` on 2 consecutive reads saves ~0.9 s of it. The measured runs show no retries ("every sign-in fill 2 confirm reads", `wdn-perf.md:679`), so the bench saving is 0.
- Proposed fix: let `ConfirmRequest` take an optional `failFast(value)` predicate that ends the wait after 2 equal reads. A `times` argument on the iOS key op would cover the Backspace RPCs, which is agent 03's wire. Files: `screen/field.ts`, `screen/locator.ts`. Additive.
- Effort: S
- Risk: low.
- How to verify: `field.test.ts`: a stable `old+text` reading returns `mismatch` after 2 reads, not at the 1 s deadline.
- Confidence: med
- Verified by: read; traced `fill` attempt 1 mismatch → attempt 2

### 07-10 The Android `setText` op is implemented in `warden-uiad` but no TS code calls it

- Category: perf-latency
- Severity: P3
- Known?: claimed-fixed-not-landed (`docs/plans/wdn-perf.md:559`: "`typeText`/fill (`setText` with readback ...)")
- Evidence: the server op exists (`native/android/src/nz/co/delacour/warden/uiad/Main.java:151-152`, `Uia.java:583`), and `packages/e2e/AGENTS.md` lists it. `grep setText packages/e2e/src` finds no TS caller. Android fill goes focus tap → `selectAll` → `typeText` (`screen/field.ts:127-174@dfcc68b`).
- Impact: estimated. Skipping the tap + `selectAll` (~30 ms each over uiad) saves ~60 ms per Android fill. Small. It may have been dropped on purpose (RN `onChangeText` semantics); if so, the plan line and AGENTS should say so.
- Proposed fix: decide, then document it or wire `setText` behind the readback in `field.ts`. Owner: agent 05 (Android driver). Additive.
- Effort: S
- Risk: med. RN controlled inputs may not see `ACTION_SET_TEXT` as typing. Needs a device.
- How to verify: Android bench fill timings before and after; `native/android/scripts/smoke.ts`.
- Confidence: med
- Verified by: read; `git log -S setText`

### 07-11 Matchers and actions throw on several matches at once, with no poll for a transition to finish

- Category: flake-risk
- Severity: P3
- Known?: new
- Evidence: `matchers.ts:302@dfcc68b` calls `pickOne`, which throws `LOCATOR_AMBIGUOUS` on the first poll that sees > 1 match (`locator.ts:705-712`). `actionable` does the same through `exactlyOne` (`locator.ts:400`). While a stack push animates, both screens are mounted and on screen, so a locator for text present on both (a title, a "Back" label) is momentarily ambiguous and fails at once. Waiting ~one animation would let it settle to one.
- Impact: estimated, low frequency. Each occurrence is a hard failure that a retry passes, i.e. a flake (cf. K13). Both platforms.
- Proposed fix: treat ambiguity as "not yet" until it has persisted for ~500 ms, or until the screen has settled, then throw with the same message. Files: `expect/matchers.ts`, `screen/locator.ts`. The strict rule's timing changes (`policy_change`); the API does not.
- Effort: S
- Risk: low. Real ambiguity fails 500 ms later.
- How to verify: FakeDriver test with 2 matches on poll 1 and 1 on poll 2: it passes. On a device, assert a shared title right after a push.
- Confidence: low
- Verified by: read

## Known items

- K9 (known-confirmed): nothing here lowers pacing. 07-6 relies on K9's garbling under load to justify verifying secure fills.
- K13 (known-extended): 07-1 and 07-11 are candidate mechanisms for a load-only timing flake (tap during a slide, a momentary ambiguity). Unproven.
- PERF-2.3 negation early end: claimed-fixed-not-landed (07-8, `wdn-perf.md:255`).
- PERF-3.3 step 6 `setText` fill: claimed-fixed-not-landed (07-10, `wdn-perf.md:559`).
- PERF-2.3 back-off (`poll.ts:35-39`) and `FIELD_POLL_MS` 50 with hit-test confirm (`field.ts:16,89-99`; `locator.ts:678`): landed as claimed.
- PERF-2.2 lazy excerpts, matcher side: landed. `failure()` renders only on throw (`matchers.ts:324-335`).
- PERF-2.4 `systemAlerts`: landed as claimed. The modal is checked on the snapshot already taken (`context.ts:126-138`); with no modal the cost is CPU only. Field read-backs pass `alerts:false` (`locator.ts:686`).

## Gaps I could not assess here

- Mis-tap rate during slide-in (07-1/07-2): run the iOS bench with a trace and compare the tap point with the next snapshot's frame of the tapped element. `bun run bench --frameworks warden --runs 3` with a temporary log.
- Whether the iOS `elementAtPoint` hit on buttons returns the button or its label (07-2's fallback rate): `warden ui` hit-test on the sign-in "Next" button.
- What secure fields report right after typing on iOS and Android (07-6): `warden ui fill <password> secret && warden ui snapshot --json`. Look for N bullets, or N−1 bullets plus one plain character.
- Whether `ACTION_SET_TEXT` drives RN `onChangeText` on API 33–37 (07-10): `native/android/scripts/smoke.ts` with a `setText` call.
- How often both screens are visible and ambiguous during an RN stack push (07-11): a snapshot loop during the sign-in push.

## Owned files not read

none. (`screen/actions.test.ts`, `field.test.ts` and `poll.test.ts` were read through their test lists and run, not line by line.)

## Questions for the user

- Is a re-sent press on a still-visible target (07-3) acceptable by design, or should `tap({until})` refuse to press again once the screen has visibly reacted? The answer decides whether 07-3 is a policy change or a bug fix.

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-07.md
- docs/plans/wdn-perf.md (PERF-1.1, 2.1–2.4, Results, Follow-ups), docs/bench/ios-2026-10-16-perf.md, docs/bench/android-2026-10-16-perf.md (What changed)
- packages/e2e/AGENTS.md (uiad, selectAll paragraphs)
- packages/e2e/src/screen/poll.ts, poll.testing.ts, field.ts, actions.ts, context.ts
- packages/e2e/src/expect/matchers.ts, expect.ts; matchers.test.ts (test list); poll.test.ts (test list); locator.tap-until.test.ts, system-alerts.test.ts (test lists)
- packages/e2e/src/screen/locator.ts (330-800, non-owned), nodes.ts:145
- packages/e2e/src/driver/typing.ts, observation-cache.ts (1-120), android/android-driver.ts (340-420, 489-581 excerpts), ios/ios-driver.ts (grep)
- packages/e2e/src/runner/attempt.ts (180-240), runner/step.ts (25-60), env.ts (grep)
- packages/e2e/native/android/src/.../Main.java, Uia.java (grep `setText`)
