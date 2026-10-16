# Assignment 09 · `device-app-launch` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/09-device-app-launch.md` and `docs/audit/raw/09-device-app-launch.jsonl`.

## Improvement goal

Shorten the time from `app.open` to the first useful step, and the waits inside `device.openLink` and `device.alert`. You own the end-to-end `app.open({ wait: "quiet" })` path (K15): other agents cite you for it.

## Owned files

- `packages/e2e/src/{device,device-link,alert-reader,alert-buttons,app,device-devtools,errors}.ts` and tests (`device.test.ts` 783, `app.test.ts`, `device-devtools.test.ts`)
- Read-only context: `packages/e2e/AGENTS.md` § `device.alert` and `device.openLink`; `docs/plans/wdn-perf.md` PERF-1.3, PERF-1.4, PERF-2.4; bench "What changed" for both platforms (the settle in `app.open({wait:"quiet"})` runs before the welcome screen is visible: 2.6 s vs 2.2 s per rep on iOS, 4.8 s vs 2.0 s on Android).

Not yours: the drivers' `launch`/`rebind` implementation (03, 05), the runner's `launch: "fresh"` wiring (08), `systemAlerts` polling inside locators (07).

## Starting hotspots

- `app.ts` (113): `open({ url, args, env, wait })`: order of terminate → launch → rebind/settle → alert handling; what `wait: "quiet"` waits on (`settle{bundleId}` with which `quietMs`/timeout) and why it costs more than a settle after the first screen is visible (K15). Propose the cheapest correct alternative (e.g. wait for the first non-launch-screen snapshot, or settle with a shorter quiet window once `rebind` reports bound) with the trade-off.
- `app.ts`: `close`, `restart`, `reinstall`, `clearData` (core `resetAppData` spawns), `isRunning`: spawn counts per call.
- `device-link.ts` (175): poll schedule (100 ms for 1 s, then 250 ms, cut to land on the 1.2 s confirmation), `ax`-only reads in the first 1.2 s, the 500 ms sheet age before pressing, ≤ 3 presses 600 ms apart, give-up 600 ms after the last press, `isFrontmost` early return, per-session memo by scheme/host, `until` locator, `waitMs` 8 s cap. Count AX reads per `openLink` with and without a sheet; name the missed case (a sheet later than 1.2 s while the app is in front) and whether a cheaper guard exists.
- `alert-reader.ts` + `alert-buttons.ts`: one bridge read, 3 × 200 ms re-looks for `{buttons:[]}`, host `ax` fallback, then the two-reader `driver.alert()` with up to 13 reads 100 ms apart: when does the 13-read path fire in practice, and what does the Android `detectAlert` on a snapshot cost?
- `device.ts` (275): `settle`, `snapshot` (text tree), `screenshot`, `hideKeyboard`, `back`, `home`, `orientation`, `appearance`, `clipboard`: any that spawn `simctl`/`adb` where the driver already has the answer; `SettleDetail` passthrough.
- `device-devtools.ts`: attach cost when `WARDEN_METRO_URL` is set and the facet is never used.
- Tests: coverage of the timing rules with the fake clock (which sleeps are real).
