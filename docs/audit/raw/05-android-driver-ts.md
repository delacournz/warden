# 05 · android-driver-ts

Scope: `packages/e2e/src/driver/android/{adb-session,android-driver,android-dump,uiautomator,android-state,android-animations,android-app,android-argv,android-device,android-alert,android-host.testing,anr.fixture,uiautomator.fixture}.ts`, their tests, and `packages/e2e/native/scripts/{fake-adb,smoke-android}.ts`. The `warden-uiad` server/client/backend/ops belong to agent 04; below I audit only the driver's `uiad?.op() ?? <old way>` decisions and the old ways.

## Top 5 by impact

- **05-1**: on Android 11+ (API 30+), `device.alert("accept")` on a camera, mic or location permission prompt presses **"Don't allow"**. No Android label matches `ACCEPT_BUTTONS`, so it falls back to the last button in the tree, which is the deny button.
- **05-4**: `app.launch` starts a JVM per launch (`monkey`) and returns before the activity has drawn. `am start -W -n <resolved component>` is cheaper and waits for the first frame, which also addresses K15's early settle.
- **05-2**: the animation guard restores the scales when any driver on the serial closes. A `warden ui` call made during an e2e run turns animations back on under the run. Every `warden ui` call also flips the three global scales twice.
- **05-3**: once the `adb shell` session has given up (device gone or offline), `waitForBoot` keeps polling a session that can never recover. It burns the full 30 s and then reports `E_NOT_BOOTED` instead of the real error.
- **05-5**: a transient `null root node` makes the dumper probe every route. One failed attempt costs about 4.8 s instead of about 1 s, up to 3 attempts, and the saved route can flip.

## Findings

### 05-1 `alert("accept")` presses "Don't allow" on Android 11+ runtime-permission prompts
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - `packages/e2e/src/driver/android/android-alert.ts:12-24@dfcc68b`: `detectAlert` collects every button whose id is in `ALERT_BUTTON_IDS`, in tree order. On API 30+ the camera, mic and location dialogs (`com.android.permissioncontroller`) show three buttons:
    - `permission_allow_foreground_only_button`, labelled "While using the app";
    - `permission_allow_one_time_button`, labelled "Only this time";
    - `permission_deny_button`, labelled "Don't allow".
  - The deny button is last in the layout.
  - `packages/e2e/src/device.ts:171@dfcc68b`: `accept` is `firstOf(buttons, ACCEPT_BUTTONS) ?? buttons[buttons.length - 1]`.
  - `packages/e2e/src/alert-buttons.ts:4,16-22@dfcc68b`: `ACCEPT_BUTTONS` holds the iOS labels ("Allow", "Allow While Using App", "Allow Once"), and `findButton` needs an exact, case-insensitive match. "While using the app" and "Only this time" match nothing, so the fallback picks the last button, which is "Don't allow".
  - Two-button prompts are unaffected: notifications (API 33) and contacts/storage show "Allow" / "Don't allow", and "Allow" matches. The ANR dialog's `aerr_close` / `aerr_wait` have no accept name, so accept falls back to "Wait", which is the last button. That one is fine.
- Impact: any Android test that grants camera, mic or location with `device.alert("accept")` (or `systemAlerts` set to accept) denies the permission. The test then fails on the app's denied path, every time on API 30+. Not exercised by the bench suite (no permission prompt on Android).
- Proposed fix: additive.
  - Export an ordered `ANDROID_ALLOW_IDS` from `android-alert.ts`: `permission_allow_button`, `permission_allow_foreground_only_button`, `permission_allow_one_time_button`, `button1`.
  - In `device.ts` `accept`, prefer the first button whose `identifier` is in that list, before the name lookup.
  - Optionally add the Android labels ("While using the app", "Only this time") to `ACCEPT_BUTTONS` and "Don't allow" (straight apostrophe) to `DISMISS_BUTTONS`. Matching on ids is more robust across locales.
  - Files: `android-alert.ts` (05), `device.ts` and `alert-buttons.ts` (09).
- Effort: S
- Risk: low. Verify on an API 30+ emulator with a location prompt.
- How to verify:
  - Unit: build a fixture dump of the three-button permission dialog in `android-alert.test.ts` and assert that `device.alert("accept")` targets `permission_allow_foreground_only_button` (device.test with FakeDriver).
  - Device: record a real dump of the prompt (as `anr.fixture.ts` did).
- Confidence: med. The ids and labels come from AOSP permission-controller layouts as I know them; they are not in a fixture in this repo.
- Verified by: traced path from `device.alert` (`device.ts:166-171`) to `detectAlert` (`android-alert.ts:33-39`) to `firstOf` (`alert-buttons.ts:24-30`).

### 05-2 The animation guard restores scales under a live driver; `warden ui` flips them on every call
- Category: flake-risk
- Severity: P2
- Known?: known-extended K17
- Evidence:
  - `android-driver.ts:194,204-212@dfcc68b`: every open reads the state file and calls `disableAnimations` with the saved `animations` as `pending`.
  - `android-animations.ts:44-56@dfcc68b`: one line reads the three scales and sets them to 0.
  - `android-state.ts:207@dfcc68b`: `planAnimations` treats a `0` read alongside a `pending` value as warden's own leftover, so the second driver also plans to restore the originals.
  - `android-animations.ts:59-73@dfcc68b`: on `close` it puts them back and deletes `animations` from the file.
  - So with process A (an e2e spec) open and process B opened on the same serial, B's close turns animations back on while A is still running. A's later runs then have animations on (the flake source the guard exists to remove), and the file no longer records anything to restore if A then dies.
  - `apps/cli/src/agent-ui/ui-driver.ts:29-37@dfcc68b` (owner 14): every `warden ui` call is a fresh `openAndroidDriver` with the file store, then `close`. Each call is therefore process B. It also costs two extra shell round trips: six `settings` calls at open and three at close. On top of that come two state-file writes (`android-animations.ts:55,72`) and two global-settings broadcasts per call.
  - The state store's queue serialises writes within one process only (`android-state.ts:129-133`). Across processes it is last-writer-wins, which is acceptable for its atomic rename but gives no ownership.
- Impact (estimated):
  - Per `warden ui` call: about 9 `cmd settings` invocations at roughly 10-25 ms each, plus 2 round trips and 2 file writes, so about 100-250 ms. This adds to K17's ~85 ms `warden-uiad` start.
  - Flake: any `warden ui` call (an agent inspecting the screen) during a `warden e2e` run on the same emulator turns animations back on for the rest of the run.
- Proposed fix: contract `store`, additive field in the state file.
  - Record an owner `{pid, startedAt}` next to `animations`.
  - On open: when the scales already read 0 and a live owner holds the record, change nothing and do not take over the restore. Take over only when the owner is dead (`kill(pid,0)` fails or `startedAt` differs).
  - On close: restore only when this process owns the record.
  - Optional: `warden ui` could pass a `keepAnimations` or "no restore" option and leave restoring to lease release.
  - Files: `android-animations.ts`, `android-state.ts`, `ui-driver.ts` (14).
- Effort: M
- Risk: med. A wrong liveness check would leave emulators with animations off. Unit-testable with `memoryAndroidState`; one device check.
- How to verify:
  - Unit: open driver A, open driver B on the same `memoryAndroidState`, close B, and assert that no `settings put … 1` was sent and that A's record is intact. Close A and assert the restore.
  - Device: run `warden ui snapshot` during a run and check `settings get global window_animation_scale` stays 0.
- Confidence: high on the mechanism. The per-call cost is estimated.
- Verified by: traced `ui-driver.ts` to `openAndroidDriver` to `disableAnimations` to `planAnimations` to `restore`.

### 05-3 `waitForBoot` spins for 30 s on a session that has given up
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `android-device.ts:31@dfcc68b`: `isFatal` covers only `E_HELPER_MISSING` and `E_INTERNAL`.
  - `adb-session.ts:77,141-146@dfcc68b`: after two consecutive deaths, `start()` returns `E_HELPER_CRASHED` immediately for the life of the session. `adb -s X shell` exits at once when the device is offline or gone, so the first probe and the one respawn both die.
  - `android-device.ts:70-83@dfcc68b`: the loop then retries an instant failure every 500 ms until the 30 s deadline and returns `E_NOT_BOOTED`, carrying the crash only in `detail.error`.
  - No test covers this: `android-device.test.ts:83-104` covers a slow flag and a timeout only.
- Impact (estimated): 30 s of dead wait per open against a disconnected or offline emulator (one per spec process, and one per `warden ui` call). The error code also tells the user the device is booting when it is gone.
- Proposed fix: additive.
  - Expose `gaveUp()` on `AdbSession`, or a distinct error detail `{gaveUp:true}`.
  - Treat a session that has given up as fatal in `waitForBoot`, and surface `E_HELPER_CRASHED` or the device-not-found message.
  - Optionally capture adb's stderr on death: today it is `"ignore"` at `adb-session.ts:41`, so "device offline" is lost.
- Effort: S
- Risk: low. Unit test with `FAKE_ADB_DIE_ON_START`.
- How to verify: in `android-device.test.ts`, use a spawn that dies on start with a fake clock. Assert `waitForBoot` returns within one or two polls with `E_HELPER_CRASHED`.
- Confidence: high
- Verified by: read; traced `waitForBoot` to `session.run` to `execute` to `start()`.

### 05-4 `app.launch` is `am force-stop` + `monkey` (a JVM start, no wait for the first frame)
- Category: perf-latency
- Severity: P2
- Known?: known-extended K15
- Evidence:
  - `android-app.ts:62-79@dfcc68b`: a relaunch is two round trips, `am force-stop` and then `monkey -p <pkg> -c android.intent.category.LAUNCHER 1` (`android-argv.ts:190-192`).
  - `monkey` is an `app_process` Java program on every API level: a fresh JVM, the same start cost `packages/e2e/AGENTS.md` cites for `input` ("took 300 ms to start").
  - `am` and `cmd package` go through `cmd` (binder, no JVM) from Android 7.
  - `monkey` returns once the intent is injected, before the activity has drawn. `app.ts:58-83` (owner 09) then settles right away. That is K15's "settles before the welcome screen is visible" on Android: 4.8 vs 2.0 s per rep (bench doc, "What changed").
- Impact (estimated): about 300-600 ms of JVM start per launch, against about 30-80 ms for `am start`. That is 0.3-0.6 s per test and 2.4-4.8 s per 8-test Android rep (one launch per test). It should also remove part of K15's 2.8 s/rep, because the settle would start after the first frame.
- Proposed fix: additive.
  - Resolve the launcher component once per driver with `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <pkg>` (last line `pkg/.Activity`) and cache it.
  - Launch with `am start -W -n <component>` (with `-S` it also force-stops, giving one round trip). `-W` blocks until the first frame and prints `Status: ok`, `LaunchState`, `TotalTime`; put `TotalTime` in span detail.
  - Fall back to `monkey` when resolution fails.
  - Files: `android-app.ts`, `android-argv.ts`. The K15 settle change itself belongs to 09.
- Effort: S
- Risk: med. `-W` timing on a debug build waiting for Metro; activity-alias launchers. Needs a device.
- How to verify:
  - Unit: argv tests in `android-app.test.ts`.
  - Device: trace `driver.app.launch` span ms before and after, then re-run `bun run bench run --platform android --runs 3`.
- Confidence: med (the JVM cost of `monkey` is inferred, not measured here).
- Verified by: read

### 05-5 A transient "null root node" re-probes every dump route (≈4.8 s per attempt, ×3) and can flip the saved route
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `android-dump.ts:77-95@dfcc68b`: every route whose output lacks `<hierarchy` is treated alike. uiautomator's own `ERROR: null root node…` (the window is not there yet: the route works, the screen is not ready) is indistinguishable from the stdout trailer-only output (the route cannot deliver on this image).
  - `android-dump.ts:100@dfcc68b`: each `dump()` walks the whole `routeOrder`.
  - `android-driver.ts:294-306@dfcc68b`: `dumpWithRetry` repeats that up to 3 times with 400 ms sleeps.
  - On API 37 (known route `tty`), one attempt is:
    1. `tty` fails fast;
    2. `stdout` is a full dump (~1.9 s) that returns only the trailer;
    3. `file` is a full dump (~1.9 s).
  - If the window appears during step 3, `file` wins and is saved (`android-dump.ts:104` to `onRoute` to the state file, `android-driver.ts:286-289`). Later processes then probe `file` first.
  - `android-dump.test.ts:82-94` pins exactly this: tty answering "null root node" moves on to `file`.
- Impact (estimated): server-off path only (`WARDEN_ANDROID_UIAD=0`, API < 26, a saved `uiadUnsupported`, or a dump fallback after a server failure). Per transient failure, about 4.8 s instead of about 1-1.9 s per attempt, up to about 11 s extra over 3 attempts. Transients cluster right after launches and navigation, which is where reads happen.
- Proposed fix: additive.
  - Classify a route's output as follows:
    - "uiautomator answered with its own error": `/ERROR:|null root node/`. Return `E_AX_UNAVAILABLE` at once without trying other routes and without changing `known`.
    - "no hierarchy and no error": the route cannot deliver. Probe the next route.
  - Re-probe only when the known route gives the second kind.
  - Files: `android-dump.ts`, `android-dump.test.ts`.
- Effort: S
- Risk: low. Unit tests cover it; check one real null-root output per image.
- How to verify: in `android-dump.test.ts`, with known `tty` returning null-root, assert 1 route tried and the route unchanged. On device with `WARDEN_ANDROID_UIAD=0`, compare `dumpRoutesTried` in `trace.jsonl` before and after.
- Confidence: high on the mechanism, med on the per-attempt ms.
- Verified by: read, and ran `bun test src/driver/android/android-dump.test.ts`.

### 05-6 The fallback `pressKeyRepeat` sends up to 32 Backspaces with no gap (the plan says this drops keys in RN)
- Category: flake-risk
- Severity: P2
- Known?: new (the plan text acknowledges it, but nothing tracks it)
- Evidence:
  - `android-argv.ts:88-96@dfcc68b`: `input keyevent 67 67 …` in chunks of 32, injected back to back.
  - `android-driver.ts:396-405@dfcc68b` uses it whenever the server declines or is off. `typing.ts:69` routes every counted Backspace run there.
  - `docs/plans/wdn-perf.md:169` says "batched keyevent 67 drops keys in RN".
  - The server path spaces repeats 30 ms apart for the same reason (`uiad-ops.ts:69,212`, owner 04).
  - On API 26-32 there is no `selectAll` without the server (`android-driver.ts:414,577`), so clearing a field is exactly this counted path.
- Impact (estimated): server-off clears on RN fields can lose Backspaces. The fill then fails to confirm, and its retry (`field.ts`, owner 07) uses the same lossy path. Per affected fill that is one or two extra confirm cycles, or a failed step.
- Proposed fix: additive. On the fallback, send one `input keyevent 67` per key joined by `&&` (each is its own JVM start, a natural gap of ≥ 300 ms), or keep the batch only for non-text targets. On API 31+, `cmd input keyevent` could add a short `sleep 0.03` between single-key calls.
- Effort: S
- Risk: low; slower but lossless. Needs a device to confirm the loss rate.
- How to verify: on device, `WARDEN_ANDROID_UIAD=0`, fill a pre-filled RN field 25 times on API 30 and count mismatches before and after.
- Confidence: med
- Verified by: read

### 05-7 The fakes match whole `;`-joined lines by prefix; the real-process test never exercises the production open path
- Category: test-gap
- Severity: P2
- Known?: new
- Evidence:
  - `native/scripts/fake-adb.ts:34@dfcc68b` and `android-host.testing.ts:38-40@dfcc68b`: a rule matches when its `match` is a prefix of the whole command line. A real shell runs each `;` part, concatenates their output and exits with the last part's code.
  - In `android-driver.fake-adb.test.ts:22-31@dfcc68b`, the rule `getprop sys.boot_completed` → `"1\n"` swallows the whole boot probe. The test therefore runs with `sdk` undefined and the `readScreen` fallback (2 extra round trips), so route order is the pre-API-30 one.
  - The animation line starts with `settings get`, so it hits fake-adb's `default:` (`fake-adb.ts:108-110`): exit 127, "could not disable animations".
  - The only end-to-end test through real child processes therefore covers the degraded open, never the 2-round-trip open, the animation read and restore, or tty-first.
  - In the in-memory fake, the base rules (`android-driver.test.ts:41-44`) answer the animation line with `""`, so most driver tests take the "unreadable scales" branch.
  - Exit-code-of-last-part semantics (05-9) cannot be expressed at all.
- Impact: n/a (test fidelity). It is why 05-9 and 05-8 stay green.
- Proposed fix: additive.
  - Teach both fakes to split a line on top-level `; ` and `&& ` (outside quotes), answer each part from its own rule, concatenate the output and exit with the last part's code (honouring `&&` short-circuit).
  - Give the fake-adb test rules for `getprop ro.build.version.sdk`, `settings get` and `settings put`, and assert the shell sequence equals the production two lines.
  - Files: `fake-adb.ts`, `android-host.testing.ts`, `android-driver.fake-adb.test.ts`.
- Effort: M
- Risk: low; tests only.
- How to verify: the new assertions in `android-driver.fake-adb.test.ts`, then `bun test src/driver/android`.
- Confidence: high
- Verified by: read; ran the owned tests (224 pass).

### 05-8 `key(name, modifiers)` reports success on API ≤ 30 where `input keycombination` does not exist
- Category: correctness
- Severity: P3
- Known?: new
- Evidence:
  - `android-driver.ts:388-392@dfcc68b`: success is judged only by exit code, with no sdk gate. `selectAll` has one (`:414`, `SELECT_ALL_MIN_SDK = 33`).
  - The pre-API-31 Java `input` prints "Error: Unknown command" plus usage and returns normally (exit 0). Only `cmd input` (API 31+) exits non-zero.
  - `android-driver.test.ts:452-458` fakes the API 31+ shape (exit 255) on an sdk-34 probe.
- Impact: a chord on API 26-30 is silently dropped, and the step passes.
- Proposed fix: return `E_UNSUPPORTED` when `sdk < 33` (or undefined) before sending, and treat output matching `/Unknown command|Usage: input/` as unsupported. Additive.
- Effort: S
- Risk: low
- How to verify: a unit test with probe(30), plus one check on an API 30 image.
- Confidence: med
- Verified by: read

### 05-9 `;`-joined lines mask failures: the animation read and restore are judged by the last command only
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - `android-animations.ts:44-52@dfcc68b`: the three `settings put … 0` run even when the reads printed something `parseAnimationValues` rejects. Animations end up off with nothing saved to restore ("will not be restored").
  - `android-animations.ts:63-72@dfcc68b`: the restore's exit code is the third `put`'s, so a failed first put still clears the record.
  - The same pattern sits in the fallback tap with `count > 1` (`android-driver.ts:367`).
- Impact: rare (it needs an odd `settings` output), but when it happens the emulator is left animation-less with no record.
- Proposed fix: join with `&&`, or have the shell check the reads before the puts (`a=$(settings get …) && …`). Alternatively, do the read and the put as two round trips only when the read fails. Additive.
- Effort: S
- Risk: low
- How to verify: unit tests once 05-7's fake models `;` and `&&`.
- Confidence: med
- Verified by: read

### 05-10 The fallback `tap({count: 2})` is two slow single taps, not a double tap
- Category: correctness
- Severity: P3
- Known?: new
- Evidence: `android-driver.ts:364-367@dfcc68b` joins `count` `input tap` calls with `; `. Each one is a JVM start (~300 ms), which reaches Android's 300 ms double-tap timeout. The server path sends `count` in one op (`uiad-ops.ts:182-188`).
- Impact: server-off double taps do not register as double taps, and the step still passes.
- Proposed fix: on the fallback, return `E_UNSUPPORTED` for `count > 1` (or try `input motionevent` DOWN/UP pairs in one line on sdk 26+; also JVM starts). Additive.
- Effort: S
- Risk: low
- How to verify: device check with `WARDEN_ANDROID_UIAD=0` on a double-tap target.
- Confidence: med
- Verified by: read

### 05-11 `smoke-android.ts` no longer smokes the production configuration
- Category: dx
- Severity: P3
- Known?: new
- Evidence: `native/scripts/smoke-android.ts:54-59@dfcc68b` opens with no `uiad`, no `state` and no `appPackage`. It therefore never runs the server path, never saves or restores animation originals (an aborted smoke leaves the scales at 0 with no record), and never routes `openUrl` through `-p`. Its header (`:10`) promises "tap p50 should be < 150 ms", which the dump/`input` path it runs cannot meet (`input tap` is ~330 ms per `packages/e2e/AGENTS.md`).
- Impact: n/a (by-hand tool)
- Proposed fix: add `--uiad` (default on, like `openDriver`) and a temp `createAndroidStateStore`. Print `health.detail.uiad` and the dump route. Assert the scales are restored after `close`. Additive.
- Effort: S
- Risk: low
- How to verify: run it on a leased emulator with both settings.
- Confidence: high
- Verified by: read

## Known items

- **K15**: known-extended. On Android, `monkey` returns before the first frame (05-4). `am start -W` gives `app.open({wait:"quiet"})` a launch that has drawn before the settle starts.
- **K17**: known-extended. Besides the ~85 ms server start, every `warden ui` call on Android also pays the animation disable and restore (about 9 `settings` calls, 2 file writes) and can undo a running e2e driver's zeros (05-2).
- **K6**: known-confirmed. Only API 37 is verified, so the fallback paths audited here (05-5, 05-6, 05-8, 05-10) are what API 26-36 lands on whenever the server refuses a level. They carry the bugs above.
- `wdn-perf.md:238` (PERF-2.1 item 4, "Android confirm hits the 1 s cache"): landed. `elementAtPoint` takes a fresh snapshot every time (`android-driver.ts:356-359`); there is no 1 s cache left. The audit hotspot that mentions a 1 s cache is stale.
- Open path "6 → 2 round trips": landed. The boot probe and the animation line are the only shell commands on a booted device (`android-driver.test.ts:95-103`). `readScreen` runs only when `wm` is unparseable, and the server starts lazily.

## Gaps I could not assess here

- The `monkey` vs `am start -W` cost per launch on the API 37 emulator: run `adb shell 'time monkey -p nz.co.delacour.warden.example -c android.intent.category.LAUNCHER 1'`, then `adb shell 'time am start -W -S -n <component>'`, 10 times each.
- Permission prompt ids and labels on API 30, 33, 34 and 37: grant location in the example app (or any app) and capture `adb exec-out uiautomator dump /dev/tty`.
- Whether killing the host `adb shell` on a command timeout (`adb-session.ts:197-202`) also kills the device-side process. This matters for a timed-out `uiautomator dump` that might keep UiAutomation (then the next server start sees `uiautomation_busy`), and for a timed-out `input motionevent` drag left after DOWN. Check: `adb shell ps -A | grep uiautomator` after forcing a 1 s timeout on a dump.
- The `input keyevent 67 ×N` loss rate on an RN field with `WARDEN_ANDROID_UIAD=0` (05-6).
- `input keycombination` exit code on an API 30 image (05-8).

## Owned files not read

- `uiautomator.fixture.ts` (fixture data; only its use in tests was read). `uiautomator.test.ts`, `android-state.test.ts`, `android-app.test.ts`, `android-argv.test.ts` and `android-alert.test.ts` were run, not read line by line. `android-driver-uiad.test.ts` and `uiad-ops.test.ts` were only grepped for the fallback cases.

## Questions for the user

- Is running `warden ui` against an emulator while a `warden e2e` run is using it a supported workflow? If not, 05-2 drops to a per-call cost item (P3).

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-05.md`, `packages/e2e/AGENTS.md` (§ Android driver internals), `docs/plans/wdn-perf.md` (Android rows, PERF-2.1, PERF-3.x, results), `docs/bench/android-2026-10-16-perf.md`
- `packages/e2e/src/driver/android/{adb-session,android-driver,android-device,android-dump,android-animations,android-state,android-argv,android-app,android-alert,anr.fixture,uiautomator,android-host.testing,uiad-ops}.ts`
- `packages/e2e/src/driver/android/{adb-session,android-dump,android-device}.test.ts`, `android-driver.test.ts` (setup, open, keys), `android-driver.fake-adb.test.ts`
- `packages/e2e/native/scripts/{fake-adb,smoke-android}.ts`
- Context only: `packages/e2e/src/driver/open.ts`, `apps/cli/src/agent-ui/ui-driver.ts`, `packages/e2e/src/{app,device,alert-buttons}.ts` (excerpts), `packages/e2e/src/driver/typing.ts` (grep)
