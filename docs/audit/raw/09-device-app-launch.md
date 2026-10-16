# 09 · device-app-launch

Auditor 09. Scope: `packages/e2e/src/{app,device,device-link,alert-reader,alert-buttons,device-devtools,errors}.ts` and their tests. Commit `dfcc68b`. Line numbers are from the files as they are now.

## Top 5 by impact

1. **09-2**: with `systemAlerts: "dismiss"` (the bench suite's setting), a locator read presses **Cancel** on the "Open in …?" sheet. That includes the `until` read inside `openLink`. The link is lost, the scheme is remembered as having no sheet, and the test waits out `waitMs`, retrying up to 3 × 6 s.
2. **09-5**: on Android, `app.open()` fails whenever `WARDEN_LAUNCH_ARGS` is non-empty. With Metro that is always, because of `--initialUrl`. Android launch refuses any args, and `app.ts` forwards them on every platform.
3. **09-1** (K15): `wait: "quiet"` goes quiet on the React Native launch screen. Its time overlaps app boot, so it buys almost nothing in wall time and gives no "first screen ready" guarantee. The fix is a settle gated on first content, or `wait: { until }`.
4. **09-4**: `app.open({ url })` on iOS calls raw `openUrl`. Nothing answers the "Open in …?" sheet, and with `systemAlerts: "dismiss"` the next read cancels it.
5. **09-6**: alert-read retries count attempts, not time. `E_TIMEOUT` is retryable, so one wedged helper can turn one `device.alert` or one `openLink` look into up to 15 × 10 s of requests, capped only by the test deadline. `openLink` can also throw, past its `waitMs`.

## Findings

### 09-1 `app.open({ wait: "quiet" })` goes quiet on the launch screen; the settle is overlapped boot time, not a ready signal (K15)
- **Category**: perf-latency
- **Severity**: P2
- **Known?**: known-extended K15 (adds the mechanism, shows the measured "cost" is overlap, ties in K18)
- **Evidence**:
  - `packages/e2e/src/app.ts:58-65@dfcc68b`: `waitUntilQuiet` makes one `driver.settle({ quietMs: 250, timeoutMs: 3000 })` and passes no bundle id. It runs after `launch` (`app.ts:77`) and after `openUrl` when one is given (`app.ts:78-82`).
  - iOS: `driver.app.launch` (`driver/ios/ios-driver.ts:465-471@dfcc68b`) sets `launchedBundle`, calls `rebind`, and clears `launchedBundle` when rebind answers `bound`. So in the normal case the following `settle` (`ios-driver.ts:289-302`) goes to the helper without `bundleId`, and the frontmost gate is not used.
  - The helper's quiet verdict is "guest reported run-loop idle + animations inactive for `quietMs`" (`packages/e2e/AGENTS.md`, `settle{…}`). While a React Native app shows its static launch screen and loads the JS bundle, the main run loop is idle and nothing animates, so 250 ms of quiet is reached on the launch screen.
  - Android: `android-driver.ts:489-493@dfcc68b` hands off to `warden-uiad` settle (accessibility events stopped), with no package filter or frontmost check. The same thing happens: the splash goes quiet.
  - The bench suite says so itself: `packages/e2e-bench/suites/warden/helpers/flows.ts:15-22@dfcc68b` ("the welcome screen can still be sliding in then, which is why the Next presses below re-send"), followed by a `toBeVisible({ timeout: 30_000 })`.
  - K18: settle with `bundleId` (FrontmostGate, dominated by app boot) now runs only when `rebind` did not bind (`ios-driver.ts:468-469`).
- **Impact**:
  - Measured settle time (bench "What changed"): iOS 2.6 s per rep = ~325 ms per launch; Android 4.8 s per rep = ~600 ms per launch (`docs/bench/ios-2026-10-16-perf.md:141`, `docs/bench/android-2026-10-16-perf.md:136`).
  - Estimated wall-time effect: about 0. The settle ends before the welcome screen is visible, so the `toBeVisible` that follows waits out the rest of the boot anyway. Removing the settle would save only polling slack, not the 325 / 600 ms. Comparing it with the hand-rolled 2.2 s / 2.0 s misleads: that settle came after the welcome screen and was extra time.
  - The real cost is that the guarantee is missing. A tap made right after `open` hits a screen that is still mounting, and a dropped first press costs a 4 s `tap({ until })` re-send (flows.ts:55-60). Neither bench run shows one (62 taps per rep), so that risk is unmeasured.
- **Proposed fix**: options, cheapest first.
  - (a) Additive API `app.open({ wait: { until: Locator } })`: launch, wait for `until` visible (the screen poll, so the observation cache keeps that snapshot), then one `driver.settle(250)`. It replaces the `open + toBeVisible` pair. The settle now lands on the real first screen, so the next tap goes to a mounted screen. The wait for `until` is the existing wait; the settle costs +~275 ms iOS / ~250 ms Android per launch (the hand-rolled figures, 2.2 s and 2.0 s over 8 launches).
  - (b) Make `"quiet"` content-gated. Poll `observe({ reuse: false })` at 100 ms until the snapshot has at least one interactive element or any `identifier` (a storyboard launch screen has neither), capped at `DEFAULT_SETTLE_TIMEOUT_MS`, then settle. Trade-off: a first screen with no identifiers and no controls waits until the cap.
  - (c) "Settle with a shorter quiet window once `rebind` is bound" saves at most ~100 ms of time that is already overlapped, and keeps the wrong semantics. Not recommended.
  - Under every option, fix the docstring at `app.ts:14-19`: today "quiet" means frontmost (iOS, via rebind) plus a quiet launch screen.
  - Files: `app.ts`, `index.ts` types, docs.
  - Contract: additive.
- **Effort**: M
- **Risk**: (b) changes what `"quiet"` waits for, which users may rely on (policy). Verifying it needs a device bench re-run.
- **How to verify**:
  - `app.test.ts`: a FakeDriver whose screens move from a launch screen to content at t = 1 s. Assert that `open({ wait: … })` returns after 1 s plus the settle.
  - On device: `bun run bench` idiomatic on iOS and Android. Compare `device.settle` spans with `via` and the timestamp of the first welcome-visible snapshot.
- **Confidence**: med. The launch-screen idle mechanism is inferred from the helper's quiet definition and the bench note. It has not been traced on a device.
- **Verified by**: traced path from `app.open` → `ios-driver.ts` launch/rebind/settle and → `android-driver.ts` settle → uiad; ran `bun test src/app.test.ts`.

### 09-2 `systemAlerts: "dismiss"` cancels the "Open in …?" sheet, inside `openLink({ until })` and after it returns
- **Category**: flake-risk
- **Severity**: P1
- **Known?**: new
- **Evidence**:
  - `fixtures.ts:16-17@dfcc68b`: `answerSystemAlert = () => device.alert(alerts)`. `screen/context.ts:116-129,133-138@dfcc68b`: every `tryObserve` with alerts on (the default; only `locator.ts:681` opts out) calls it when `snapshot.modal` is set.
  - The "Open in …?" dialog ranks as an alert (rank 2) in `topmostModal` (`native/ios/Sources/warden-simd/Ops/Snapshot.swift:401-421@dfcc68b`, comment at :411). The bench suite relies on `systemAlerts` "answering" exactly that sheet (`packages/e2e-bench/suites/warden/helpers/flows.ts:10-13@dfcc68b`).
  - `device.ts:172@dfcc68b`: dismiss presses `firstOf(buttons, DISMISS_BUTTONS)`, which is "Cancel" first (`alert-buttons.ts:5`). Cancel on that sheet drops the link.
  - Inside `openLink`, `waitForLink` (`device-link.ts:165-174@dfcc68b`) runs `lookForSheet` (a cheap `ax` read, `:100-101`) and then `reachedTarget` → `until.isVisible()` (`device.ts:134-141`, a full screen read with alerts on). If the sheet appears between those two reads, the locator's read sees it first and cancels it.
  - Every poll after the hand-over (`watch.looking = false`, `:171`) and every poll of a remembered link in its first 1.2 s (`:99`) is a locator read only, with no sheet look.
  - Once cancelled, the sheet is never seen by `lookForSheet`. So `lastSheetAt` stays at `started`, the 1.2 s window closes, the app is in front, and `sheetless.add(key)` runs (`:168-169`). The scheme is now remembered as having no sheet, although it has one.
- **Impact**:
  - Estimated chance per un-remembered link: (ax read ~6-40 ms + snapshot start) / poll cycle (~100 ms sleep + ~76 ms snapshot, iOS snapshot ≈ 13.0 s / 170 per rep, bench `ios-…perf.md:141`) ≈ 20-40 % that a sheet appearing mid-cycle is met by the locator read first. This needs device confirmation.
  - Each loss costs `waitMs` (bench: 6 s) plus a retry (`flows.ts:85-99`, 3 attempts). The bench's own comment that "a link … is occasionally dropped, with nothing on screen to tell it from a slow one" fits this mechanism.
  - Platform: iOS.
- **Proposed fix**: two additive changes.
  - (1) Inside `waitForLink`, check `until` with system-alert answering off. The device owns the sheet: give `LinkDeps.isVisible` a read with `alerts: false` through an internal locator hook, or set a "link in flight" flag that `screenHostFor`'s `answerSystemAlert` honours.
  - (2) In `device.alert`, never press a dismiss button on a sheet whose title starts with "Open in". Under `"dismiss"`, answer it with "Open" or leave it, because Cancel only destroys a link the test asked for.
  - Files: `device.ts`, `device-link.ts`, `fixtures.ts` (08), `screen/locator.ts` / `context.ts` (07).
- **Effort**: M
- **Risk**: low. It needs a fresh simulator (sheet not yet accepted) to verify.
- **How to verify**:
  - `device.test.ts`: `openLink({ until })` with a FakeDriver whose sheet appears between the `alertOn` call and the next `snapshot`, plus a `testHost` with `answerSystemAlert` → `device.alert("dismiss")`. Assert that Open is pressed, not Cancel, and that the key is not memoised.
  - On device: erase the sim, run the deep-link flow 20× and count `device.alert` spans with `answered: true` during `device.openLink`.
- **Confidence**: med
- **Verified by**: traced path from `openLink` → `waitForLink` → `reachedTarget` → `locator.isVisible` → `tryObserve` → `answeredAlert` → `device.alert("dismiss")`.

### 09-3 A sheet later than 1.2 s with the app in front is missed, and the "no sheet" memo is never invalidated
- **Category**: flake-risk
- **Severity**: P2
- **Known?**: new (an AGENTS.md "limit", no K-ref)
- **Evidence**:
  - `device-link.ts:124-128@dfcc68b`: `handedOver` needs only a confirmed read and `appInFront()`. When the link targets the app that is already frontmost (the usual case: `openLink` after `launch`), both hold at t = 1.2 s before a slow sheet appears.
  - `OPEN_LINK_WAIT_MS` (`device-link.ts:7-8`) itself says a loaded machine "can show the sheet several seconds after `openUrl` returns".
  - The memo is then set (`:169`) and never removed. `sheetlessFor` (`:30-34`) has no `delete`, and a remembered link that later meets and presses a sheet (`:99`, then the full-reader polls) stays remembered.
- **Impact**:
  - The first link of a scheme on a loaded host returns while the sheet is still to come. The next read either cancels it (09-2) or, with `systemAlerts: "off"`, finds the app covered until its timeout.
  - Every later link of that scheme skips alert reads for 1.2 s and returns on frontmost alone.
  - Estimated cost: one `waitMs` per occurrence (6-8 s), iOS only.
- **Proposed fix**:
  - Remove the key from the memo when a remembered link presses a sheet (`lookForSheet` press branch). This is cheap and additive.
  - For the first link of a key, require evidence that the link was handled before memoising: a change in the app tree hash since a snapshot taken before `openUrl` (PERF-1.3 option 2; one extra read of ~76 ms, first link only). Otherwise keep the 1.2 s return but do not memoise.
  - No cheaper on-device guard exists: nothing tells "sheet not yet up" from "no sheet" before it draws.
  - Files: `device-link.ts`, `device.ts`.
- **Effort**: S
- **Risk**: low. With the second change the memo is set less often, so first links of a session stay at ~1.3 s.
- **How to verify**:
  - `device.test.ts`: `link({ sheetAt: 1500 })` with the app in front from 0. Assert the key is not memoised, or that a later sheet removes it.
  - On device: deep-link flow under `stress -c N`.
- **Confidence**: high (logic). The real-world frequency needs a device.
- **Verified by**: read; ran `bun test src/device.test.ts`.

### 09-4 `app.open({ url })` on iOS skips the "Open in …?" sheet handling
- **Category**: correctness
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `app.ts:78-81@dfcc68b` calls `driver.app.openUrl(url)` (raw `simctl openurl`, `ios-driver.ts:477`). The sheet logic (`device.ts:185-204`, `device-link.ts`) never runs.
  - With `wait: "quiet"`, the settle that follows (`app.ts:82`) can report quiet with the sheet up, because the bound stream was cleared at rebind.
  - With `systemAlerts: "dismiss"`, the next locator read presses Cancel (09-2).
- **Impact**:
  - On a simulator that has not accepted the scheme, `app.open({ url })` lands on the plain launch screen with a sheet on top. The test then fails, or waits out its assertion timeout.
  - Estimated cost: 1 assertion timeout per occurrence. iOS.
- **Proposed fix**: route `url` through the device's link wait. Share `waitForLink` from `device.ts` via a small `openLinkWith(driver, session, env, clock)` helper, and call it with `{ until: undefined }` in `app.ts`. Additive.
- **Effort**: S
- **Risk**: low. It adds ~1.3 s to a first `open({ url })` without a sheet, and nothing to later ones (memo).
- **How to verify**: `app.test.ts`: a FakeDriver with `alertBackends` and a sheet at 300 ms. Assert Open is tapped.
- **Confidence**: med. Whether the sheet shows for `openurl` while the target app is frontmost needs a device check.
- **Verified by**: read.

### 09-5 Android `app.open()` fails whenever `WARDEN_LAUNCH_ARGS` is non-empty (always with Metro)
- **Category**: correctness
- **Severity**: P1
- **Known?**: new
- **Evidence**:
  - `app.ts:72-77@dfcc68b` always sends `args: [...env.launchArgs, ...]`.
  - `driver/android/android-app.ts:62-67@dfcc68b` returns `E_UNSUPPORTED` when `args` is non-empty, which `unwrap` turns into `ACTION_FAILED`.
  - The CLI builds `WARDEN_LAUNCH_ARGS` without regard to platform: `apps/cli/src/e2e/launch.ts:39-42@dfcc68b`, `apps/cli/src/commands/e2e.ts:393`. With Metro it prepends `--initialUrl <metroUrl>` (`apps/cli/src/metro.ts:286`), and Android jobs do get Metro (`apps/cli/src/commands/batch.ts:1066,1180-1185`).
  - The bench avoids this only because its adapter forces `WARDEN_LAUNCH_ARGS: "[]"` (`packages/e2e-bench/src/adapters/warden.ts:97`).
- **Impact**: every `app.open()` fails on Android, including the runner's `launch: "fresh"` default, for any suite with Metro enabled or `spec.launchArgs` set. That is a P0 for those suites. I rated it P1 because I could not confirm that such a suite is run today.
- **Proposed fix**:
  - In `app.ts`, on `driver.platform === "android"`, drop `env.launchArgs` (log once) and keep only explicit `options.args`, which should still fail loudly.
  - Or have the CLI emit `[]` for Android legs. The dev client gets Metro through `adb reverse` plus its default URL, or through `openUrl` with a dev-client deep link, as the error message suggests.
  - Files: `app.ts`, or `apps/cli/src/e2e/launch.ts` (12).
  - Contract: additive (env semantics per platform documented).
- **Effort**: S
- **Risk**: low
- **How to verify**:
  - `app.test.ts`: `platform: "android"` env with `launchArgs: ["--initialUrl", "x"]` → `open()` succeeds and `app.launch` gets no args.
  - On device: `warden e2e example --platform android` with Metro.
- **Confidence**: med (the code path is certain; whether such runs exist is not).
- **Verified by**: traced path from `specLaunchArgs` → `WARDEN_LAUNCH_ARGS` → `env.launchArgs` → `app.ts:73` → `android-app.ts:62`.

### 09-6 Alert-read retries are counted in attempts, not time; `openLink` can overrun `waitMs` and throw
- **Category**: robustness
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `alert-reader.ts:57-64@dfcc68b` retries any `retryable` failure up to 13 times, 100 ms apart. `driver/errors.ts:4-10@dfcc68b` makes `E_TIMEOUT`, `E_HELPER_CRASHED` and `E_AX_UNAVAILABLE` retryable, and each iOS request times out at `DEFAULT_TIMEOUT_MS` 10 s (`driver/ios/simd-client.ts:71`).
  - Before that, `readOne` (`:66-75`) has already spent one bridge request and one host request on the same failure. On a hung helper, one `device.alert` is up to 15 requests × 10 s, bounded only by `session.signal`.
  - In `openLink`, the cheap `ax` look (`device-link.ts:101`) falls back to `readBoth` on failure (`alert-reader.ts:76`). The loop checks its `deadline` only after a look (`device-link.ts:167`), so `waitMs` does not bound reads.
  - A non-retryable or exhausted read throws out of `openLink`, although its docs say it "never throws" for time (AGENTS.md).
  - When the 13-read path fires in practice:
    - (i) every `openLink` confirmation read (`backend` undefined);
    - (ii) iOS, only after both single-reader reads failed;
    - (iii) every Android `device.alert` (no `alertOn`). There it is one `driver.alert()`, i.e. `detectAlert` over a snapshot that the observation cache usually serves for free (`observation-cache.ts:135-147`). On a retryable `uiautomation_busy` that is 13 × 100 ms ≈ 1.3 s before a `DRIVER` error.
- **Impact**:
  - Healthy path: none.
  - With a wedged helper, a test hangs to its deadline instead of failing fast with `DRIVER`.
  - Estimated worst case: 150 s per call, iOS. Android ~1.3 s per call while busy.
- **Proposed fix**:
  - Give `readBoth` a time budget (e.g. 1.2 s total, to match its doc) and do not retry `E_TIMEOUT` there.
  - In `waitForLink`, pass the remaining `deadline - now` and catch read errors as "no sheet seen".
  - Files: `alert-reader.ts`, `device-link.ts`.
- **Effort**: S
- **Risk**: low
- **How to verify**: `device.test.ts`: `onCall` failing `alert` / `alertOn` with `E_TIMEOUT` that advances the fake clock by 10 s. Assert that `device.alert` gives up within ~1.2 s plus one request, and that `openLink` returns at `waitMs`.
- **Confidence**: high
- **Verified by**: read; ran `bun test src/device.test.ts`.

### 09-7 Tests run every alert and link timing rule on a fake clock where reads cost 0 ms and "frontmost" ignores the sheet
- **Category**: test-gap
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `device.test.ts:27-36@dfcc68b`: `fakeClock` moves only on `sleep`, so the poll-schedule assertions (`:353-370`, `[0,100,…,1000]`, `[1200,1450,1700]`) hold only for 0 ms reads. Real `ax` reads are 6-40 ms and snapshots ~76 ms, so the real cadence and read counts differ.
  - `link()` (`:320-333`) answers `frontmost` from the clock alone, even while the sheet is up. Whether the real `frontmost` is false under a SpringBoard sheet decides `handedOver`, and nothing pins it.
  - No test combines `openLink` with a `systemAlerts` host (09-2).
  - No test covers `app.open({ wait: "quiet" })` when rebind did not bind (the gated settle, K18).
  - `device-link.ts` and `alert-reader.ts` have no colocated tests (AGENTS rule 4).
  - Counted read budget per `openLink` without a sheet, not remembered, app in front: 11-12 host `ax` reads (100 ms apart over 1.2 s, ~10 with real read latency) + 1 two-reader read (2 tree reads) + 1 `frontmost`. Remembered: 1 `frontmost`. With a sheet seen at time s: ~s/100 + 5 reads before the press (500 ms age), 1 tap, then reads until the sheet is gone (≥ 1).
- **Impact**: the schedule tests can pass while devices behave differently. Under the fake the 09-2 race window is 0.
- **Proposed fix**:
  - Add `readCostMs` to the fake clock (advance the clock in `alertOn` / `snapshot`).
  - Add a sheet-aware `frontmost` in `link()`.
  - Add the 09-2 and K18 tests.
  - Move the `waitForLink` cases into `device-link.test.ts` and add `alert-reader.test.ts`.
  - Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: the new tests fail on the current code for 09-2 and 09-3.
- **Confidence**: high
- **Verified by**: ran `bun test src/device.test.ts src/app.test.ts src/device-devtools.test.ts` (102 pass).

### 09-8 `app.clearData()` on iOS is 7 serial `xcrun simctl` spawns
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `app.ts:107@dfcc68b` → `simctl.clearData` (`driver/ios/simctl.ts:272-283`) → core `resetAppData` (`packages/core/src/builds/install.ts:266-279`), which runs, one after another:
    - `isAppInstalled` (`:272`);
    - the `resetIos` steps (`:220-249`): `terminate` (`:229`), `spawn defaults delete` (`:230`), `get_app_container data` (`:233`), `get_app_container groups` (`:211`), `privacy reset all` (`:245`);
    - `keychain reset` (`:254`), always, because `app.ts` passes `keychain: true`.
  - Android: 1 `pm clear` in the resident shell.
- **Impact**: estimated 7 × ~150 ms per `xcrun simctl` spawn ≈ 1 s per call (unmeasured), iOS, only for tests that call it.
- **Proposed fix** (owner 17): after `terminate`, run `defaults delete`, the `groups` lookup, `privacy reset` and `keychain reset` concurrently (they are independent), and skip `isAppInstalled` when `get_app_container data` answers.
- **Effort**: S
- **Risk**: low. Verifying needs a sim.
- **How to verify**: core `install.test.ts` with an injected exec that records concurrency; on device, time `app.clearData` before and after.
- **Confidence**: med
- **Verified by**: traced path from `app.clearData` to `resetIos`.

### 09-9 `app.reinstall()` probes "installed?" twice
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `app.ts:102-104@dfcc68b` calls `isInstalled` and then `uninstall`.
  - iOS: both run `probe` (`get_app_container`, `simctl.ts:225-229,261-267`), so 4 spawns where 3 are enough.
  - Android: `uninstall` calls `isInstalled` again (`android-app.ts:96-99`).
- **Impact**: estimated 1 spawn (~150 ms) per reinstall, iOS.
- **Proposed fix**: call `uninstall` directly; it already returns ok when the app is not installed. Files: `app.ts`. Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: `app.test.ts`: `reinstall` issues no `app.isInstalled`.
- **Confidence**: high
- **Verified by**: read.

### 09-10 `openLink({ until })` polls at 250 ms after the hand-over and overshoots `waitMs` by up to one poll plus one look
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - After `handedOver` (`device-link.ts:168-171@dfcc68b`), `nextPollMs` (`:141-145`) sees `sinceSheet` ≥ 1200, so it returns 250 ms. The screen's own wait polls at 100 ms for the first second (PERF-2.3).
  - `clock.sleep` (`:173`) is not clamped to `deadline`, and the deadline check (`:167`) runs after a full look plus `isVisible`.
- **Impact**: estimated ~+75 ms average detection latency when the target shows after 1.2 s, and up to ~350 ms past `waitMs`, per link, iOS.
- **Proposed fix**: use 100 ms polls for `until` after the hand-over, and `sleep(min(poll, deadline - now))`. Files: `device-link.ts`.
- **Effort**: S
- **Risk**: low
- **How to verify**: a fake-clock test asserting return ≤ `waitMs`, and `until` detected within 100 ms.
- **Confidence**: high
- **Verified by**: read.

### 09-11 `device.hideKeyboard()` always takes a fresh full snapshot
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: new
- **Evidence**: `device.ts:233-235@dfcc68b` → `readSnapshot` → `driver.snapshot()`. The cache's `snapshot` never reuses a kept snapshot (`driver/observation-cache.ts:128-133`). A `hideKeyboard` right after a `fill` (whose confirm just read the screen) pays a second read.
- **Impact**: estimated ~76 ms per call on iOS (bench snapshot mean); Android uiad ~10-30 ms.
- **Proposed fix**: use `observe({ reuse: true })` when the driver can observe; the generation bump after input keeps it safe. Files: `device.ts`. Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: `device.test.ts`: snapshot, then `hideKeyboard` → 1 driver snapshot.
- **Confidence**: high
- **Verified by**: read.

## Known items

- **K15**: known-extended. The settle reaches quiet on the launch screen: iOS rebind clears the bundle gate and the stream sees run-loop idle; Android has no frontmost gate. Its 325 / 600 ms per launch overlaps boot, so its wall cost is ~0, and the missing ready guarantee is the real issue (09-1).
- **K18**: known-extended. `settle{bundleId}` after a relaunch now runs only when `rebind` did not bind (`ios-driver.ts:468-469`); `app.open` never passes the bundle itself (09-1, 09-7).
- **K16**: not changed here. `app.open` races `simctl launch` against the session signal only (`app.ts:77`); `LAUNCH_MS` belongs to 03.
- **PERF-1.3**: verified landed. Back-off 100/250 ms, return after 1.2 s plus frontmost, full wait while another app is in front, memo per scheme/host, `until` / `waitMs`, and an `ax`-only reader are all at `device-link.ts`, `device.ts:185-204` and `alert-reader.ts`. Remaining gaps: 09-2, 09-3.
- **PERF-1.4**: verified landed. One bridge read, re-looks only for `{buttons: []}`, and the Android alert served from the cached snapshot (`observation-cache.ts:135-147`).
- **PERF-2.4** `app.open({ wait })`: landed, with the semantic gap in 09-1.

## Gaps I could not assess here

- Whether `snapshot.modal` is set for the SpringBoard "Open in …?" sheet in an axbridge snapshot, and how often a locator read meets it before `lookForSheet` (09-2). On an erased sim: `warden e2e <suite> --flows todo-detail-deep-link` × 20 with `systemAlerts: "dismiss"`. Count `device.alert` spans with `answered: true` inside `device.openLink`, and the `openLink` attempts used.
- Whether `frontmost{bundleId}` is false while that sheet is up (decides `handedOver`): `warden ui` on a sim with a pending sheet, then the `frontmost` op.
- When the welcome screen first shows relative to the end of the settle: trace `device.settle` end against the first `read.isVisible` that sees `welcome.screen` per launch, on both platforms.
- Real cost of the iOS `xcrun simctl` spawns in `clearData` / `reinstall`: time `app.clearData()` on a booted sim.
- `simctl launchctl list` (`isRunning`) against the helper's launchd lookup (~150 ms): not measured.

## Owned files not read

none

## Questions for the user

1. Is `warden e2e --platform android` meant to work with Metro / dev-client builds today? If yes, 09-5 is P0. If Android is release-build only, it is a latent P1.
2. Should `wait: "quiet"` keep meaning "frontmost + quiet", even on a launch screen, or become "first content + quiet" (09-1b)? The second changes a default users may rely on.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-09.md`, `packages/e2e/AGENTS.md` (Android internals, device.alert/openLink, warden-simd)
- `docs/plans/wdn-perf.md:185-290`, `docs/bench/ios-2026-10-16-perf.md:110-141`, `docs/bench/android-2026-10-16-perf.md:105-138`
- Owned:
  - `packages/e2e/src/app.ts`, `device.ts`, `device-link.ts`, `alert-reader.ts`, `alert-buttons.ts`, `device-devtools.ts`, `errors.ts`
  - `device.test.ts` (sections), `app.test.ts` (sections), `device-devtools.test.ts` (list)
- Context:
  - `packages/e2e/src/driver/settle.ts`, `driver/alerts.ts`, `driver/unwrap.ts`, `driver/errors.ts:1-14`, `driver/observation-cache.ts` (grep)
  - `driver/ios/ios-driver.ts:110-180,255-370,440-490`, `driver/ios/simctl.ts:200-300`
  - `driver/android/android-driver.ts:320-360,470-600`, `driver/android/android-app.ts:20-115`, `driver/android/android-alert.ts`
  - `fixtures.ts`, `traced-device.ts`, `screen/context.ts:95-175`
  - `native/ios/Sources/warden-simd/Ops/Snapshot.swift:401-600`
  - `packages/core/src/builds/install.ts` (grep `resetAppData`)
  - `apps/cli/src/e2e/launch.ts:30-42`, `apps/cli/src/commands/e2e.ts` (grep), `apps/cli/src/commands/batch.ts` (grep)
  - `packages/e2e-bench/suites/warden/helpers/flows.ts`, `suites/warden/sign-in.e2e.ts`
  - `apps/docs/content/docs/guides/specs.mdx:62`
