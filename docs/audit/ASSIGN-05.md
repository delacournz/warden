# Assignment 05 · `android-driver-ts` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/05-android-driver-ts.md` and `docs/audit/raw/05-android-driver-ts.jsonl`.

## Improvement goal

Make the Android driver's open and per-op paths faster, make the fallback rules between `warden-uiad`, `uiautomator dump` and `input` correct, keep the per-serial state file sound, and check the fake adb against the real argv.

## Owned files

- `packages/e2e/src/driver/android/{adb-session,android-driver,android-dump,uiautomator,android-state,android-animations,android-app,android-argv,android-device,android-alert,android-host.testing,anr.fixture,uiautomator.fixture}.ts` and their tests (`android-driver.test.ts` 912, `android-driver.fake-adb.test.ts`, `android-driver-uiad.test.ts`, `uiad-ops.test.ts` only where it exercises the driver's fallback)
- `packages/e2e/native/scripts/{fake-adb.ts,smoke-android.ts}`
- Read-only context: `packages/e2e/AGENTS.md` § Android driver internals; `docs/plans/wdn-e2e.md` "Android real-device pass" (the six failures found and fixed there).

Not yours: the uiad server, client, backend, device, ops (agent 04). When the driver calls `uiad?.op() ?? <old way>`, audit the `<old way>` and the decision, cite 04 for the server side.

## Starting hotspots

- `adb-session.ts` (230): one resident `adb shell` with a sentinel protocol; queueing, respawn-once, what happens to queued commands when the shell dies, FIFO fairness between `input` and the dump fallback, timeouts per command.
- Driver open (`android-driver.ts:178-222`): the one probe line (`getprop sys.boot_completed; getprop ro.build.version.sdk; wm size; wm density`), 500 ms poll up to 30 s even though the provider already waited for `boot_completed`; `disableAnimations` one shell call; `readScreen` fallback; how many adb round trips before the first snapshot (plan said 6 → 2).
- `android-dump.ts`: route order (`tty` from API 30 else `stdout`, `file` fallback), 3 × 400 ms retry on `E_AX_UNAVAILABLE`, `rm -f` before the file route, and the ~1.9 s per dump floor when the server is off (`WARDEN_ANDROID_UIAD=0` or API < 26). What does a run look like when the server is unavailable: dumps per test, settle = one dump.
- `android-state.ts` (214): atomic write, trust only on the same API level, animation originals restored on `close`; a process that dies without closing leaves zeros (restored by the next driver): any path where originals are lost or an unset scale is written as "0"?
- `android-argv.ts` (330): `textArgvs` quoting (`%s`, `%` followed by a space, shell metacharacters), `pressKeyRepeat` chunks of 32, `input motionevent` drag (8 interpolated MOVEs); timeouts sized at 10 s + 8 s per piece.
- `elementAtPoint` 1 s snapshot cache and its drop rules on any input/app call; `alertIn`/`detectAlert` reading from a fresh server snapshot.
- `android-app.ts`: `am start -p <pkg>`, `monkey`/`am start -n`, `am force-stop`, `pm clear`, host `adb install -r`; spawn counts per `app.open` and `clearData`.
- `android-alert.ts`: `ALERT_BUTTON_IDS` incl. ANR (`aerr_close`/`aerr_wait`); permission-controller allow button on API variants.
- **Fake fidelity**: `fake-adb.ts` and `android-host.testing.ts` vs the argv the driver really emits: list any command shape the fake accepts that real adb would not, or vice versa.
- Tests asserting with real sleeps instead of a fake clock.
