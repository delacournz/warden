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
| 9 | Dropped characters | Key pacing too fast, or keys sent while focus was still moving to the field (iOS: first letters lost or moved, `"Hllo"`) | Never lower `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS` / `WARDEN_SIMD_LEAD_MS`; a stubborn field on a loaded host: raise `WARDEN_SIMD_LEAD_MS` (first letters) or `WARDEN_SIMD_PACE_MS` (later ones), then `warden ui close --udid <udid>` so the helper restarts with it. `fill` (spec, `warden ui`, specs) and spec `type` / `press` wait for the field to report `focused`; by hand, `press` the field then `is <sel> focused` before `type`. `fill` verifies and retries |
| 10 | App back at Welcome mid-test | Native crash | Read `~/Library/Logs/DiagnosticReports/<app>-*.ips` |
| 11 | Deep link ignored | Opened while the app was settling | `device.openLink(url, { until })` again (example app: `openDeepLink`) |
| 12 | `E_AX_UNAVAILABLE` right after launch | Transient (marked retryable) | Retry the call. `simctl launch` can take >30 s under load |
| 13 | Exit 3 `engine_unavailable` | No `warden-simd` helper | `warden doctor --fetch-helper` (Intel Mac: no helper) |
| 14 | Locator not found | View is not `accessible` | Fix the component (`accessible` + `testID`); inspect with `warden ui snapshot -i` and `warden ui tree` |
| 15 | Tests run stale JS on a Release build | Native-only fingerprint | Use the `simulator` kind (the `warden e2e` default: the JS is repacked per content) or `native+js` with `jsInputs` in the build config |
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
| 32 | Dev client crashes at start with `Cannot find native module '<X>'` after a native dependency change | The dev build was made from a stale git-ignored `ios/` / `android/` (prebuild and `pod install` skipped), so it lacks the new module | Current warden regenerates a CNG native dir prebuilt for another fingerprint before a local build (log: `ios/ was prebuilt for …: removing it`). A build cached by an older warden stays: `warden builds rm <hash>` (the hash `warden dev` logs; also forgets its install records), then `warden dev ios` rebuilds. Never via EAS unless the project configures it |
| 33 | `several e2e suites — name one (…)` / `no e2e suite "x"` / `no e2e suites in warden.config.ts and no e2e/ specs … run warden init` | `[suite]` is optional only with one suite; with none configured the default suite needs an Expo app with `e2e/` | Name the suite, or `warden init` |
| 34 | `suite "x" runs on ios and android — pass --platform` | The suite sets no `platform` | `--platform ios\|android`, or set `e2e.<suite>.platform` |
| 35 | `--all and --specs are exclusive`, `--all / --specs select without a diff — drop --files`, `--specs matched no spec` | Selection flags clash, or the ids/globs match nothing | Use one of them, drop `--files`; list ids with `warden e2e <suite> --all --dry-run` |
| 36 | `--passes N needs isolate "spec"` (flag or suite) | `isolate: device` reruns a whole shard, so it cannot repeat per spec | `isolate: "spec"` in the suite (the default once `passes > 1`), or drop `--passes` |
| 37 | `--install-mode / --reset-keychain need an app to install, but suite "x" has no app`; `--reset-keychain needs --install-mode` | The suite installs nothing, or the keychain reset has no mode | Set `e2e.<suite>.app` or pass `--app`; add `--install-mode clean\|reinstall`. Refused before any device is claimed |
| 38 | `--devices needs e2e.<suite>.devices` / `--devices: no leg "x" (…)` | The suite has no `devices` legs, or the profile is not one of them | Use a profile listed in the error, `default`, or `all`. `--profile` / `--count` replace the legs |
| 39 | Config load fails: `slim is iOS-only`, `slim: <unknown id>`, `serveReady needs serve`, `devices replaces profile / count`, `at least one device leg must be a default one`, `passes > 1 needs isolate "spec"`, `e2e.<suite>.warmRunners was removed` | Suite schema (unknown keys are errors too) | Fix the key named in the message; `warmRunners` is now `warmDrivers`; slim ids come from `warden sim profiles` |
| 40 | Claim sits on `queued #N of M (priority) — <reason>` | Host capacity or memory pressure holds the boot queue (a macOS kernel `warn` holds it only under 25% free; `critical` always) | `warden capacity` / `warden queue` show why and the order. `--no-wait` fails at once; `--wait <dur>` bounds it (default 30m); `WARDEN_CAPACITY=off` bypasses the gate (own risk) |
| 41 | `warden repack` exits 1 `no repack: new Android resource(s): … needs a full build` (`result: "fallback"`); `app ensure --kind simulator` / `e2e` log `repack not possible (<reason>): building the release kind instead` | Android: an image / raw resource was added or renamed since the base was built, and those live in the compiled resource table (changed vector drawables are not detected) | Nothing to fix for a run: it builds the `release` kind (full native + JS, minutes) and installs that. To get repacks again, rebuild the base with the new images: `warden builds rm <hash of the simulator-base row in warden builds ls>`, then `warden repack android` |
| 42 | `repack: no expo binary under …/node_modules/.bin` / `repack: the bundler wrote no main.jsbundle` / `repack: hermesc was not found` / `repack: hermesc output is not Hermes bytecode` | Dependencies not installed in this worktree, the bundler failed, or the Hermes compiler is missing | `bun install` in the project, then `warden repack <platform>`. The bundler's last 2000 chars of output are in the error |
| 43 | `repack: no entry file in <dir>` | No `package.json` `main` and no `index.js/ts/tsx/jsx` | Set `main` in `package.json` (`expo-router/entry` works) |
| 44 | `--kind and --variant can't be combined` / `--dev and --kind can't be combined` / `--kind / --dev and --variant can't be combined` | The kind picks the whole build; a variant is the old kind-less build | Drop one. Suite: `app: { kind }` or `app: { variant }`, not both |
| 45 | `warden e2e` ignores the suite's `metro` block (specs skip dev-client checks, no `WARDEN_METRO_URL`) | `metro` applies only with `--dev` / kind `dev` since the default build is the repacked simulator one | `warden e2e <suite> --dev`, or pin `app: { kind: "dev" }` in the suite |
| 46 | stderr `warning: fingerprint.include "native+js" of project <p> is ignored by --kind …` | The project's kind-less JS-aware key does not apply to `dev` / `simulator` | Move `fingerprint.jsInputs` to `kinds.simulator.jsInputs`, or drop `fingerprint.include`; `--kind release` keys on JS anyway |
| 47 | Android repack fails naming `zipalign`, `apksigner`, `aapt2`, `zip` or `unzip` | SDK build-tools or the system zip tools are missing | Install Android SDK build-tools (`sdkmanager "build-tools;<version>"`, found under `ANDROID_HOME`); `zip` / `unzip` ship with macOS |
| 48 | `warden ui` exits 2 `device_unauthorized` on a phone | adb lists the phone as `unauthorized`/`authorizing`: the USB-debugging prompt was not accepted for this computer | Unlock the phone, accept the prompt (tick Always allow), retry. The lease is kept. `boot` on it says the same |
| 49 | `warden ui` exits 2 `device_offline` on a phone | adb lists the phone as `offline`, `no permissions`, `recovery`, … (`details.adbState`) | Replug the cable (or `adb connect` / re-pair wireless debugging), unlock the phone, retry. The lease is kept |
| 50 | `E_DEVICE_LOCKED` (`warden ui` exit 2 `device_locked`) | The phone sits behind a PIN / pattern / password keyguard. warden wakes a sleeping phone and dismisses a keyguard with no credential, never unlocks a secure one | Unlock the phone by hand, retry. Set the phone's screen timeout long enough for the run |
| 51 | `E_REFUSED`: `physical_protected: <pkg> was not installed by warden` | `uninstall` / `clearData` on a phone only touch `WARDEN_BUNDLE_ID` and packages in the `installs` table for that serial | Do it on the phone yourself, or install the app through warden first. There is no override |
| 52 | Install fails `abi_mismatch: … has native code for x86_64 but <serial> runs arm64-v8a` | The `simulator` kind targets the host CPU; a phone is arm | Use the `dev` or `release` build kind for a phone |
| 53 | Install fails `a differently-signed copy of <pkg> is installed` (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) | The phone holds the app signed with another key (a store build) | Uninstall it yourself on the phone. warden never uninstalls it for you |
| 54 | `warden ui --udid <iPhone>` exits 2 `device_locked` (the runner host log says `Unlock … to Continue`) | The iPhone is locked; XCUITest cannot start or drive it | Unlock the phone (keep it awake), retry once. warden never unlocks it |
| 55 | `warden ui` on an iPhone fails `ios_team_ambiguous` (or the runner build fails `no_team`) | The keychain holds several `Apple Development` identities, so no signing team can be picked | Set `WARDEN_IOS_TEAM_ID=<team>` or `ios: { teamId }` in `warden.config.ts` |
| 56 | `E_UNSUPPORTED` from `pinch`, `rotate`, `gesture` or `press shake` / `back` on an iPhone | The on-device XCUITest runner takes single-finger taps, swipes and drags only | Use `swipe` / `drag`, or run the check on a simulator |

## Code lookup

`warden ui` exit codes:

| Exit | Error codes |
|---|---|
| 0 | ok |
| 1 | `failed` `usage` `target_not_found` `no_alert` `no_recording` `recording_active` `target_exists` `empty_recording` `verify_failed` `verify_unavailable` `helper_missing` `use_failed` `wait_target_absent` `wait_target_hidden` `wait_target_present` `wait_text_absent` `wait_not_stable` `session_active` `session_not_found` `app_not_found` `unsupported` `not_profileable` (perf codes) |
| 2 | `device_foreign` `device_busy` `device_not_leased` `no_device_leased` `ambiguous_device` `lease_not_found` `device_unknown` `device_unauthorized` `device_offline` |
| 3 | `engine_unavailable` `devtools_unavailable` `tool_missing` |
| 4 | `stale_ref` (snapshot again) |
| 130 | `interrupted` |

Other codes:

| Code | Meaning |
|---|---|
| `E2eError` codes | `LOCATOR_NOT_FOUND` `LOCATOR_AMBIGUOUS` `INVALID_LOCATOR` `ACTION_FAILED` `TIMEOUT` `NOT_ACTIONABLE` `INVALID_ARGUMENT` `SESSION` `DRIVER` `ASSERTION` `PERF_BUDGET` (a `device.perf.stop()` budget breach; `warden e2e --perf` lists it under the test) |
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
- Android has a helper too, the resident `warden __android-host` (log: `$WARDEN_HOME/android-host/<serial>.log`). If it is stuck, run `warden ui close --serial <serial>`. `WARDEN_ANDROID_HOST=0` drives in-process (slower: each call reopens adb + uiad). If you run from source, `ui close` after editing driver code, because the host only notices a changed `cli.ts`.

## Metro ownership

- `warden dev` owns Metro: it starts it on your leased port and verifies it serves this worktree. Never start Metro by hand.
- `port <p> is served by <dir>, not this worktree`: another checkout's Metro holds the port. Stop it or let warden pick another port.
- Two devices on one Metro: the runner pins by `WARDEN_DEVICE_NAME`.

## Version mismatch

`warden e2e` and `@delacour/warden-e2e` ship in lock-step. The preload refuses to run on a mismatch and exits 2 with the fix:

```bash
bun add -d @delacour/warden-e2e@<warden version>
```
