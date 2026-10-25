# Troubleshooting

## Symptom to fix

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | First tap after launch or navigation ignored | View is in the AX tree before it takes touches | Settle, then re-tap: `warden ui press <t> --settle` then `wait`; in a spec `tap({ until: <what the tap opens> })` re-sends it |
| 2 | testIDs vanish 1-6 s after sign-in; keys go nowhere | iOS "Save Password?" sheet | App under the e2e flag: `autoComplete="off"` + `textContentType="oneTimeCode"`. Spec: `test.use({ systemAlerts: "dismiss" })` or `device.alert("dismiss")`. Never `defaults write` |
| 3 | `--settle` not quiet, or `frontmost_mismatch` | Still animating, or a SpringBoard prompt is up | Warning only. After a relaunch allow 2-7 s. `warden ui alert get` |
| 4 | Settle takes ~2.5 s | Two helpers on one simulator | `warden ui close --udid <udid>`, or kill the stale `warden-simd --udid <udid>` |
| 5 | `reload_failed`, or reload hit other devices | `reload` fell back to Metro's broadcast `/reload` | `warden ui open <bundleId> --relaunch --udid <udid>`, then `warden ui logs start` |
| 6 | `port <p> is served by <dir>, not this worktree` | A foreign Metro owns the port | Stop that Metro or let warden pick another port. Never start Metro by hand |
| 7 | `device_mismatch` | Two devices on one Metro | The runner pins by `WARDEN_DEVICE_NAME`; set it by hand when running manually |
| 8 | "0 of 1 elements", or `ax` fallback after relaunch | Helper's stream is reopening | Wait ~2 s; else `warden ui close --udid <udid>` restarts the helper. `warden doctor` shows `degraded` |
| 9 | Dropped characters | Key pacing too fast, or keys sent while focus was still moving to the field (iOS: first letters lost or moved, `"Hllo"`) | Never lower `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS`. `fill` (spec, `warden ui`, specs) and spec `type` / `press` wait for the field to report `focused`; by hand, `press` the field then `is <sel> focused` before `type`. `fill` verifies and retries |
| 10 | App back at Welcome mid-test | Native crash | Read `~/Library/Logs/DiagnosticReports/<app>-*.ips` |
| 11 | Deep link ignored | Opened while the app was settling | `device.openLink(url, { until })` again (example app: `openDeepLink`) |
| 12 | `E_AX_UNAVAILABLE` right after launch | Transient (marked retryable) | Retry the call. `simctl launch` can take >30 s under load |
| 13 | Exit 3 `engine_unavailable` | No `warden-simd` helper | `warden doctor --fetch-helper` (Intel Mac: no helper) |
| 14 | Locator not found | View is not `accessible` | Fix the component (`accessible` + `testID`); inspect with `warden ui snapshot -i` and `warden ui tree` |
| 15 | Tests run stale JS on a Release build | Native-only fingerprint | Use `native+js` with `jsInputs` in the build config |
| 16 | Lease vanished | A bare agent claim lasts 5 min, no auto-refresh | Run through a wrapper or `warden heartbeat`; `warden ui --claim` takes over a stale lease |
| 17 | `open` did not restart the app | `open` attaches to a running app | `warden ui open <bundleId> --relaunch` |
| 18 | Scroll went the wrong way | `scroll` = content direction, `gesture swipe` = finger direction | Use the other verb |
| 19 | Preload exits 2 with a version message | `warden` and `@delacour/warden-e2e` are lock-step | `bun add -d @delacour/warden-e2e@<warden version>` |
| 20 | Android slow or unsupported | `uiautomator dump` (the server is off or could not start); no args on launch | Deep link instead of `--metro`; ASCII text only without the server. Check `warden ui status` / `WARDEN_E2E_DEBUG=1` for `uiad:` lines; `WARDEN_ANDROID_UIAD=0` forces the dump |
| 21 | Form submitted by `hideKeyboard` | iOS Enter | `device.settle()` or tap elsewhere |
| 22 | `logs`/`network` show old output | No collector running | `warden ui logs start`, then act |
| 23 | `E_AX_UNAVAILABLE`: "another UiAutomation client holds <serial> (pid N: ...)" | Android allows one UiAutomation connection per device and Maestro, an `am instrument` run or a `uiautomator` command has it. The dump would only die with `Killed`, so warden names the holder and does not touch it | Stop that process (the message gives its pid and command line) or release the device; warden kills only its own stale `warden-uiad` (`app_process … nz.co.delacour.warden.uiad.Main`). `input`-based taps and keys still work meanwhile |
| 24 | A press right after `fill` on Android is lost | The app was still taking the typed text in | The driver already waits 80 ms of quiet after text and keys; in a spec `device.settle()` before the press |
| 25 | `gesture pinch`/`rotate`/`path` fails `E_UNSUPPORTED`, `reason: helper_outdated` (iOS) | `warden-simd` predates the gesture op | `warden ui close --udid <udid>`, or rebuild: `bun run --cwd packages/e2e native:build` |
| 26 | `record stop` exits 1 `verify_failed` | The generated spec failed on the device (missing wait, wrong state, secret unset, FIXME) | File and journal are kept. Read `screen-at-failure.txt` in the printed `verify/<ts>/` dir, fix the app or `record undo` + redo, `record stop` again |
| 27 | `verify_unavailable` | No suite found, several suites, or the runner could not start | `--suite <name>` (or fix `warden.config.ts`), or `--no-verify`; journal kept |
| 28 | `target_exists` / `recording_active` / `no_recording` | Spec or helper already there; a recording already open on this device; none open | `--overwrite` or `--to <other>`; `record stop`/`cancel` first; `record start` first. `--force` is not the fix |
| 29 | Spec says `set WARDEN_UI_SECRET_<NAME>` | A `fill --secure` step reads its secret from env | Export it for the run (suite `env`); at record time export it before `fill --secure` |
| 30 | `record use` exits 1 `use_failed` / `helper_missing` | The helper failed on the device (its prerequisite does not hold, a missing wait); or the module / export is not where `<module#fn>` says (module is relative to the cwd) | Nothing was recorded. Read the printed `screen-at-failure.txt` under `$WARDEN_HOME/ui/<udid>/use/<ts>/`, bring the device to the helper's prerequisite, run `record use` again |
| 31 | `record stop` config has `entries: []` and a "fill by hand" hint | Release build (route capture needs a dev client's React DevTools hook through Metro), no `routerRoot` on the suite, or 3 failed route reads in a row ended capture | Record against a dev client (`warden dev`, `ui open --metro`); set `routerRoot` in the suite; or write `entries` by hand. warden never edits `warden.config.ts` |

## Code lookup

`warden ui` exit codes:

| Exit | Error codes |
|---|---|
| 0 | ok |
| 1 | `failed` `usage` `target_not_found` `no_alert` `no_recording` `recording_active` `target_exists` `empty_recording` `verify_failed` `verify_unavailable` `wait_target_absent` `wait_target_hidden` `wait_target_present` `wait_text_absent` `wait_not_stable` |
| 2 | `device_foreign` `device_busy` `device_not_leased` `no_device_leased` `ambiguous_device` `lease_not_found` |
| 3 | `engine_unavailable` `devtools_unavailable` |
| 4 | `stale_ref` (snapshot again) |
| 130 | `interrupted` |

Other codes:

| Code | Meaning |
|---|---|
| `E2eError` codes | `LOCATOR_NOT_FOUND` `LOCATOR_AMBIGUOUS` `INVALID_LOCATOR` `ACTION_FAILED` `TIMEOUT` `NOT_ACTIONABLE` `INVALID_ARGUMENT` `SESSION` `DRIVER` `ASSERTION` |
| `no driver factory configured` | `bun test` run without `--preload @delacour/warden-e2e/preload` (and no preload in `bunfig.toml`) |
| `warden e2e` exit | 0 ok, 1 a required spec failed, 130 interrupted |
| `warden affected --strict` | exit 3 when a changed file reaches no spec |
| `warden check` | exit 2 when another owner holds the device |
| batch job | exit 124 = job killed for exceeding its timeout |

On a spec failure read `screen-at-failure.txt` and `failure.png` in the test's evidence folder (see `specs.md`).

## Helper

- `warden doctor` shows helper health. `degraded` means the accessibility guest is present but its last read failed; the next good read clears it.
- No helper (exit 3): `warden doctor --fetch-helper`. Intel Macs have none.
- Two helpers on one simulator: reads stay correct but settle falls to ~2.5 s. Keep one helper per leased simulator: `warden ui close --udid <udid>` or kill the stale `warden-simd --udid <udid>`.
- A stuck helper: `warden ui close --udid <udid>`; the next call restarts it.

## Metro ownership

- `warden dev` owns Metro: it starts it on your leased port and verifies it serves this worktree. Never start Metro by hand.
- `port <p> is served by <dir>, not this worktree`: another checkout's Metro holds the port. Stop it or let warden pick another port.
- Two devices on one Metro: the runner pins by `WARDEN_DEVICE_NAME`.

## Version mismatch

`warden e2e` and `@delacour/warden-e2e` ship in lock-step. The preload refuses to run on a mismatch and exits 2 with the fix:

```bash
bun add -d @delacour/warden-e2e@<warden version>
```
