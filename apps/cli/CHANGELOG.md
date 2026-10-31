# @delacour/warden

## 0.7.0

### Minor Changes

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Add `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID, Touch ID and Android fingerprint on warden-claimed simulators and emulators. Answers `{ enrolled, modality }`; a physical device or an Android `enroll` / `unenroll` fails with `E_UNSUPPORTED`.
  - Add `device.biometrics.status()`, `enroll()`, `unenroll()`, `match()` and `fail()` to `@delacour/warden-e2e` specs (`BiometricState`, `DeviceBiometrics` types). Android `enroll` / `unenroll` throw `ACTION_FAILED`.
  - Add the `biometrics` config key (top level, `e2e.<suite>`, `batches.<preset>`; default `false`) and the `--biometrics` flag on `claim`, `run`, `batch` and `e2e`. Devices get the profile `<profile>+bio`, with their own pool and golden snapshot.
  - Android `+bio` devices start from a golden snapshot with a fingerprint already enrolled (screen-lock PIN `1111`); `warden golden ensure --platform android --profile <profile>+bio` builds it ahead of the first claim.
  - iOS `+bio` simulators are enrolled on every boot and again when a spec process starts, before the app is installed.
  - Android `+bio` golden snapshots are saved past the lock screen with the screen kept on; a claim returns once adb, the package manager and the unlocked screen answer, unlocking with the PIN if needed, and an emulator that never gets ready is shut down instead of left locked.
  - `warden ui reload` / `eval` / `logs` and the other devtools verbs find a dev client on a `+bio` simulator (Metro reports the `+` in its name as a space).

- [#117](https://github.com/delacournz/warden/pull/117) [`a0ba85c`](https://github.com/delacournz/warden/commit/a0ba85c8a0bbb21b6cd06e92ee2b8806f2d06fef) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Device conditions set on a lease (network, location, clock, …) are always undone when the lease is released or garbage-collected.
  - Android emulators can be set offline (airplane mode, checked against the device's connectivity state) or shaped to the `edge`, `3g`, `4g`, `lte`, `wifi`, `slow` and `lossy` network presets.
  - A per-lease network shaping proxy throttles bandwidth, adds latency, jitter and packet loss, and injects per-host faults (HTTP status, reset, delay, blackhole); it is stopped and its port freed when the lease is released.
  - Simulated location: set a point, follow a route of waypoints (speed, interval), replay a GPX file, or run a built-in scenario (`city-run`, `city-bike`, `freeway`) on iOS simulators and Android emulators.
  - Flaky networks: flap between online and offline on a schedule (with seeded jitter), or run a timeline of network and location changes; every change is recorded next to the test results.
  - iOS simulator apps get network conditions per app: launched with a small injected library that sends their traffic through the lease's shaping proxy, so presets and offline switch live without touching the Mac's network or other simulators. A running app without it fails with `E_NETWORK_RELAUNCH` unless the relaunch is opted into.
  - Spec API: `device.network.set/during/flap/fault/status/reset`, `device.location.set/route/scenario/clear`, `device.clock.set/advance/during/reset` and `device.timeline([...])`; `during` restores the previous condition even when the callback throws.
  - `warden.config.ts` takes a `conditions` key (top level or per `e2e` suite) for `network`, `location` and `clock`; each spec starts from that baseline.
  - iOS: apps using `NSURLSession.sharedSession` are shaped too, and changing a host fault cuts connections already open to that host.
  - Mock clock: shift (`offset`), set (`fixed`) or freeze (iOS) the wall clock an app sees; monotonic clocks are untouched. Android emulators set the device time; frozen time is iOS only.
  - Specs know their lease (`WARDEN_LEASE_ID`): network and clock conditions work under `warden e2e` on iOS, and every condition a spec sets is recorded, so a crashed spec process is still undone when the lease is released.
  - `warden ui network` is now a group: `network log` shows the request log (the old `warden ui network [n]` still works and points to it), and `network set <preset>`, `network flap`, `network fault`, `network status`, `network reset` set conditions on the device.
  - New `warden ui location set|route|gpx|scenario|clear|status` and `warden ui clock set|advance|status|reset`; `warden ui status` lists the conditions active on the lease.
  - Releasing a lease also puts a still-running iOS app launched with network or clock conditions back online and on the real clock.
  - More conditions: app permissions (`device.permissions.set`, `warden ui permission`), timezone and locale, text size and contrast (`device.a11y`), battery level and charging (Android real, iOS status bar only), Android memory warnings and iOS push notifications. Each is undone when the lease is released.
  - Conditions left behind by a lease that expired or was deleted any other way (including by an older `warden`) are undone before the device is claimed again, and by `warden gc` for unleased devices.
  - On iOS, a network or clock change that cannot tell whether the app is running now fails instead of being staged silently, and another injected app still running on the simulator no longer stands in for the app under test.
  - `device.permissions.set` / `warden ui permission` on iOS retry a `simctl privacy` call that hangs on a simulator that just booted.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Physical devices: lease, drive and test real Android phones and iPhones/iPads.

  **Claiming**
  - `warden claim --physical` leases a connected phone or tablet; `--serial <serial...>` (Android) and `--udid <udid...>` (iOS) name the devices and imply `--physical`. A plain `warden claim` never takes a physical device, even with `--adopt`.
  - `--physical` is rejected together with `--count`, `--max`, `--slim`, `--headless`, `--runtime` and `--adopt`; `--serial` / `--udid` are rejected on the wrong platform. Leases and `warden claim --json` carry a `physical` field.
  - A physical device is never booted, created, shut down, erased or slimmed: `warden release --shutdown` and `warden gc` leave it running, and it costs nothing in host capacity.
  - An iPhone or iPad is picked only when it is reachable: its tunnel is connected, it is wired, or `devicectl device info lockState` answers within 5 s (20 s for a phone named with `--udid` or `physical.ids`; probes run in parallel). An answer means reachable even when the phone is locked: `warden devices` and `warden doctor` show it as locked. Devices that are listed as available but are offline (an iPad in a drawer) are shown with a reason and never auto-picked. An Android phone that is `unauthorized` or `offline` is never auto-picked either.
  - Naming an unusable device with `--udid` / `--serial` fails `device_offline` with the reason and what to do.
  - `physical: { allow: [...] }` in `warden.config.ts` and `WARDEN_PHYSICAL_IDS` (comma-separated, wins over the config) limit what an id-less `--physical` claim may pick. Naming a device with `--udid` / `--serial` still works for any device. A `warden.config` that cannot be read fails the claim instead of ignoring the list.
  - An id-less `--physical` claim with more than one usable phone (ready, reachable, unleased, on the allowlist) no longer picks silently, in `warden claim`, `warden ui --claim`, `warden e2e`, `warden run` and `warden batch`. In a terminal a picker lists name, model, OS version and transport (cancel = `Aborted.`, exit 1); otherwise, or with `--json`, it fails `ambiguous_device` (exit 2) with `error.details.candidates` and the hint to pass `--udid` / `--serial` or set `WARDEN_PHYSICAL_IDS`. The choice is made once before any lease, build or job; one candidate is still picked without asking.
  - A claim of a locked iPhone (`warden claim`, `run`, `batch`, `e2e`, `ui --claim`) no longer stalls: before any lease warden prints `<name> is locked: unlock it to continue (waiting up to 2m)`, polls `lockState` every 10 s with a progress line about every 30 s, and continues once the phone is unlocked. Still locked after 2 minutes, or with `--no-wait`, it fails `device_locked` (exit 2, hint `unlock the phone, then retry`; `--json` error code `device_locked`). No lease is held while waiting.
  - A claim that polls for a device (a named phone that is offline, a pool that is fully leased) now prints `waiting for …` and `still waiting …` lines about every 30 s instead of staying silent until `--wait` runs out.

  **Android phones**
  - `warden ui` drives Android phones: `--serial <adb serial>` (USB, `ip:port` or wireless-debugging serials) or `--claim --physical`. It exits 2 with `device_unauthorized` (accept the USB debugging prompt) or `device_offline`; the lease is kept.
  - A device with qemu properties set (`localhost:5555`, Genymotion) is a foreign emulator, never a phone.
  - warden wakes the screen and dismisses a keyguard with no credential; a PIN, pattern or password lock fails `E_DEVICE_LOCKED` and warden never unlocks it. Rotation, dark mode and animation scales are saved before the first change and restored on close.
  - `uninstall` and `clear data` refuse any package warden did not install (`E_REFUSED`, `physical_protected`). Installing an APK checks its ABIs first and fails `abi_mismatch` with a hint to use the `dev` or `release` kind; `INSTALL_FAILED_UPDATE_INCOMPATIBLE` says to uninstall the differently-signed copy yourself.
  - `test.use({ systemAlerts })` and `device.alert` close the "Save password to Google Password Manager?" sheet with Back for both `accept` and `dismiss`; warden never presses Never or Continue.

  **iPhones and iPads**
  - `warden claim ios --physical` and `--udid <udid>` lease paired devices listed by `devicectl`; a paired device with Developer Mode on and reachable is ready. `warden ui --udid <iPhone udid>` (or `--claim --physical`) starts an on-device XCUITest runner once, then `snapshot`, `press`, `fill`, `type`, `swipe`, `screenshot`, `open` and the rest talk to the phone through it.
  - Single-finger input only: `pinch`, `rotate`, `gesture`, `press shake` and `press back` fail `E_UNSUPPORTED`. On an iPhone `screen appearance` is read-only, `screen rotate` goes through `devicectl`, and a locked phone exits 2 with `device_locked`.
  - `ios: { teamId, runnerBundleId }` in `warden.config.ts` and `WARDEN_IOS_TEAM_ID` choose the Apple team that signs the runner; without them warden uses the keychain's `Apple Development` team when there is exactly one and fails `ios_team_ambiguous` listing the teams otherwise.
  - The runner is built with `xcodebuild build-for-testing -allowProvisioningUpdates`, cached per team and Xcode build, and rebuilt for a new phone or when its provisioning profile ends within 24 hours. Failures carry a code and a hint (`no_account`, `no_team`, `bundle_id_taken`, `device_locked`, `developer_mode_off`, `runner_untrusted`, `ui_automation_disabled`, `device_busy`, `ddi_unavailable`, `unsupported_os`).
  - `fill` and `press` on an iPhone type one character at a time so a React Native field keeps every key, and Backspace, Enter, Tab and Space are typed on the software keyboard (a retry now clears the field).
  - The resident iPhone runner host records which runner build it serves; when the runner changes (a new warden, an edited runner source) the next `warden ui` / `warden e2e` replaces the host and prints `runner changed; restarting the iPhone runner host`, so no manual restart is needed. A phone leased to another session keeps its host and fails `device_busy` (exit 2) instead.

  **Tests**
  - `warden e2e`, `warden run` and `warden batch` take `--physical`, `--serial` and `--udid`; `physical: true | { ids }` on an e2e suite or device leg does the same, and the flags win. A physical run never reboots, hides, arranges, slims, golden-clones or shuts down a device, and a suite `setup` command still runs. `WARDEN_UDIDS` carries the adb serial / CoreDevice UDID and each job of a phone gets `WARDEN_DEVICE_KIND=physical`.
  - A physical e2e run installs the `release` build kind by default (an explicit `--kind` or the suite's `app.kind` wins). On an iPhone, `--app` (or a suite `app`) builds the app for the device and installs it with `devicectl` (see Device builds).
  - On an iPhone, `warden e2e` starts the runner host before the specs and stops when it cannot (a locked phone exits 2 with `device_locked` and an unlock hint, no spec runs, `e2e-report.json` carries `error`); a lost runner connection restarts it once and reruns the test, and the phone is never rebooted.
  - `test(title, { requires: ["pinch" | "multiTouch"] }, body)` skips a spec on a device whose driver lacks the capability (a physical iPhone has neither).

  **Device builds**
  - `warden app ensure ios --udid <iPhone> --kind release|dev`, `warden e2e --udid <iPhone>` and `--app` on `run` / `batch` build the app signed for the phone (`xcodebuild -destination generic/platform=iOS -allowProvisioningUpdates`, team from `WARDEN_IOS_TEAM_ID`, `ios.teamId` or the keychain) and install it with `devicectl device install app`. The build is cached apart from simulator builds, keyed on the team; with no `--kind` an iPhone gets `release`. `--kind simulator` and `--variant` are refused on an iPhone.
  - `projects[].ios.device.bundleIdentifier` in `warden.config.ts` replaces the bundle id on a phone (and is the specs' `WARDEN_BUNDLE_ID` there) when your app's id belongs to another Apple team.
  - `--install-mode reinstall|clean` on an iPhone uninstalls and reinstalls (app data cannot be wiped in place); `--reset-keychain` is refused. A phone that the app's provisioning profile does not list is registered automatically: warden builds once with `-destination id=<udid>`, rebuilds the cached device build and installs again (once per phone); `device_not_in_profile` is reported only if that does not help.

  **Output and diagnosis**
  - `warden devices` has a `KIND` column (`virtual` or `physical`), shows why a physical device is unusable (`unauthorized`, `offline`, `unpaired`, `developer mode off`) with a hint, and takes `--physical` to list only phones and tablets; `--json` rows carry `kind`, `transport` and `hint`. `warden ls` tags physical leases.
  - `warden doctor` adds `ios-team`, `ios-devices`, `ios-runner` and `android-devices` rows, only when a phone or a signing team exists.
  - The warden skill gains a physical-devices reference.

### Patch Changes

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - An Android app install is no longer skipped on a matching key alone: the emulator's installed `base.apk` must have the cached apk's sha256, so an emulator holding an older build of the same native build (an older `warden repack`, a restored snapshot) gets the current one without `--install-mode reinstall`. A truly identical build is still kept.

- [#114](https://github.com/delacournz/warden/pull/114) [`776daf0`](https://github.com/delacournz/warden/commit/776daf07a1dfe8587e24abecd5acf1d07ddf6326) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `device.alert` on iOS answers `true` only once the alert is gone: a press that lands while the sheet is still animating in (LocalAuthentication's "Face Not Recognized") is pressed again, and an alert that survives three presses throws `ACTION_FAILED` instead of reporting it answered.

- [#115](https://github.com/delacournz/warden/pull/115) [`cc761a1`](https://github.com/delacournz/warden/commit/cc761a192ca0e85bf793a09739e6dd295cdd09ac) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `fill`, `type` and `warden ui fill` / `warden ui type` no longer drop or reorder the first letters of the text in a controlled React Native input (`"Hllo"`, `"Hllo, World 123!e"`): the helper now waits 60 ms between the first key and the second, while the field re-renders on its first change
  - `WARDEN_SIMD_LEAD_MS` sets that pause (0 turns it off)

- [#119](https://github.com/delacournz/warden/pull/119) [`d2d728f`](https://github.com/delacournz/warden/commit/d2d728fd14c4ea22ceada794eb31668ba583fd5c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Two `warden dev` (or `--app`) runs on one checkout no longer both build the app: one local build runs per checkout and platform, the other waits (`waiting for the app build…`), then installs that build. A run that read its fingerprint while the other build was prebuilding now waits too, instead of building in the same tree and removing its `ios/` mid-build.
  - A waiting run shows the running build's output live in its own log, from the first line.
  - A checkout that changed while waiting, with nothing cached for the new fingerprint, fails with `the <platform> checkout changed since it was fingerprinted (A → B)`; run again.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Biometrics on a physical device are refused up front instead of being silently ignored: `--biometrics` with `--physical` / `--serial` / `--udid` fails the claim (`claim`, `run`, `batch`, `e2e`, `ui --claim`), and an `e2e` suite that sets both `physical` and `biometrics` is refused when `warden.config.ts` loads.
  - `device.biometrics` and `warden ui biometrics` fail with `E_UNSUPPORTED` on a physical iPhone, as they already did on an Android phone: a real Face ID / Touch ID sensor cannot be enrolled or matched. A session on a phone never tries to enroll.

- [#118](https://github.com/delacournz/warden/pull/118) [`26c8ce5`](https://github.com/delacournz/warden/commit/26c8ce5e0e28490ea0d2d37400891b0e25863843) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Device conditions and settings (`warden ui network|location|clock|permission|timezone|locale|a11y|battery|memory-warning|push`, `device.network`, `device.location`, `device.clock` and the other spec condition APIs) fail with `E_UNSUPPORTED` on a physical iPhone or Android phone, before anything reaches the phone: warden never flips a phone's airplane mode, clock, timezone or font scale.
  - An `e2e` suite that sets both `physical` and `conditions` is refused when `warden.config.ts` loads.
- Updated dependencies []:
  - @delacour/warden-e2e@0.7.0

## 0.6.0

### Minor Changes

- [#111](https://github.com/delacournz/warden/pull/111) [`28085a6`](https://github.com/delacournz/warden/commit/28085a66a50170c91e1dc0d72ff12da632f2251e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `fill` (`locator.fill`, `warden ui fill`) types the text key by key by default again; `via: "paste"` / `--via paste` keeps the one-Cmd+V paste on iOS as an opt-in. On Xcode 27 every simulator's pasteboard is synced with the Mac clipboard in both directions, so a paste put e2e values (emails, passwords) into the Mac clipboard and clipboard managers, and during a parallel `warden e2e` / `warden batch` run onto the other simulators' pasteboards, where another test could paste them.
  - `warden ui record` journals `via: "paste"` when a fill was pasted and nothing when it was typed; the generated spec passes `{ via: "paste" }` only. Recordings with `via: "type"` still load and generate a plain `fill`.

- [#107](https://github.com/delacournz/warden/pull/107) [`81c409a`](https://github.com/delacournz/warden/commit/81c409ab1bba1426eea8b64e4d41fa8e06828878) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every command run with `--json` now prints one JSON document on stdout when it fails, too: `{"ok":false,"command":"<command>","error":{"code":"usage"|"failed","message":"…"}}`. `usage` is an unknown option or a missing argument, `failed` the rest; the exit code and the red line on stderr are unchanged. Commands that already print their own failure document (`warden ui`, `warden perf`, `warden release`) keep it.
  - `warden dev logs --json` failures add `"ok": false` and `"command": "dev logs"` beside `error`.

### Patch Changes

- [#107](https://github.com/delacournz/warden/pull/107) [`81c409a`](https://github.com/delacournz/warden/commit/81c409ab1bba1426eea8b64e4d41fa8e06828878) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `--json` output larger than 64 KB is no longer cut off when the reader is slow to start (an agent, `jq` behind another step): warden waits for stdout to flush before it exits
  - `warden dev --json` prints its `{ udid, port, metroUrl, leaseIds, source }` document on one line, so the first stdout line is the whole document as documented
  - `warden run --json` prints its summary on one line and sends the child's stdout to stderr, so stdout holds only the JSON document
- Updated dependencies []:
  - @delacour/warden-e2e@0.6.0

## 0.5.0

### Minor Changes

- [#56](https://github.com/delacournz/warden/pull/56) [`d97701e`](https://github.com/delacournz/warden/commit/d97701e96ab61b5598ecb6ddfe9ae817346f3f91) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui` on Android keeps one resident host per emulator, which holds the adb shell, `warden-uiad` and animations-off open between calls: `snapshot -i` takes about 90 ms (was 0.6-6 s) and `press` about 120 ms (was about 570 ms). The host starts on the first call and exits after 10 idle minutes, on `warden ui close`, or when the device is released. `warden ui status` shows it as the helper.
  - `WARDEN_ANDROID_HOST_IDLE_TIMEOUT` sets the host's idle exit (`2m`-style). `WARDEN_ANDROID_HOST=0` drives the emulator in-process, as before. A host that cannot start falls back to in-process with a note on stderr.
  - `warden batch` stops a resident host before it prepares its emulators.

- [#109](https://github.com/delacournz/warden/pull/109) [`2120021`](https://github.com/delacournz/warden/commit/2120021f8b7c505d2c0723163a5c34cd5258c689) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - New `warden repack ios|android [--project <dir>] [--force] [--json]`: bundles this worktree's JS into the cached simulator build in seconds (the native base is built once per native fingerprint) and prints the base hash, `jsKey`, artifact, `reused` / `repacked`, bundle time or the fallback reason. Exit 1 when Android images changed and no repack is possible.
  - Build kinds: `projects[].kinds.<dev|simulator|release>` (`build`, `env`, `jsInputs`) and `app: { kind }` in an e2e suite. `simulator` is a Release build with no JS embedded plus a per-JS repack keyed by content, not branch; `release` embeds the JS; `dev` is the Debug dev client.
  - `warden e2e` now defaults to the repacked simulator build, repacked once before the devices install: a JS edit no longer rebuilds native. A suite's `metro` block applies only with `--dev` (or when the suite pins `app.kind: "dev"` / `app.variant`). Suites with `app.variant` behave as before.
  - `warden e2e --dev` runs the dev client on a Metro warden starts (the suite's `metro` block, or the defaults); `--kind dev|simulator|release` picks the build. They can't be combined with each other or with `--variant`.
  - `warden app ensure`, `run`, `batch` (`--app`) and `warden ui open` take `--kind`; `warden ui open --kind simulator|release` installs that build, relaunches when it changed and launches without Metro. Defaults are unchanged without the flag.
  - A project's `fingerprint.include: "native+js"` now warns once on stderr when a run asks for `--kind dev` or `simulator`, which key on the native fingerprint.
  - `warden builds ls` shows each build's kind, base, jsKey, worktree, branch, size and age; `--json` carries them.
  - The claim spinner of `warden e2e`, `batch` and `run --app` now says what the app is really doing (building the ios app (fingerprint …), fetching the EAS build, repacking JS, waiting for another device's build) and only says installing once an install actually starts.
  - Android repacks sign with the project's `android/app/debug.keystore` when present.

- [#103](https://github.com/delacournz/warden/pull/103) [`2052caa`](https://github.com/delacournz/warden/commit/2052caa0f3706f815bb1f5e967b4cbab232ccc5e) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` now runs only what the agent loop needs (dev build, Metro, simulator, app): the perf HUD sampler and the CDP devtools broker are off by default. `--hud` and `--devtools` start them with the session; `--no-hud` is still accepted.
  - New `warden dev enable <hud|perf|devtools|all>`, `warden dev disable …` and `warden dev status [--udid] [--json]` turn those extras on and off in a running `warden dev` from another shell.
  - The dashboard's `h` key now starts and stops the HUD sampler instead of only hiding the box.
  - The mouse wheel no longer moves the task selection in the `warden dev` dashboard.
  - `warden ui` devtools verbs on a session without a broker hint `warden dev enable devtools`.

- [#105](https://github.com/delacournz/warden/pull/105) [`4e918b5`](https://github.com/delacournz/warden/commit/4e918b51602251b9a554783d49f651285fb22f04) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e`: a passed gate now shuts down the sims / emulators warden created (and closes their windows) locally too, not only under `CI`. Set the suite's `shutdown: "idle"` to keep them booted for the next run, or pass `--no-shutdown`.

### Patch Changes

- [#102](https://github.com/delacournz/warden/pull/102) [`89f56fe`](https://github.com/delacournz/warden/commit/89f56fe2bab718926872e9f5d2bea2a02eadbb5b) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` specs on a dev client (`WARDEN_METRO_URL`) run with React Native's LogBox off: no warning/error toasts and no error inspector cover the app or take taps, fatals included, after every relaunch and JS reload too. Logs still reach `console.jsonl` and Metro's terminal.

- [#110](https://github.com/delacournz/warden/pull/110) [`ba0c2cc`](https://github.com/delacournz/warden/commit/ba0c2cca86cb48eadcdf61b10351077f44aaaa10) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` bundles a `simulator` / `release` run's JS with the suite's `metro.env`, so `EXPO_PUBLIC_*` values such as a fake backend URL reach the repacked build (and its cache key) instead of `.env*` or the shell's values
- Updated dependencies []:
  - @delacour/warden-e2e@0.5.0

## 0.4.0

### Minor Changes

- [#94](https://github.com/delacournz/warden/pull/94) [`f672d27`](https://github.com/delacournz/warden/commit/f672d27add2101afa452375f85d34308755fd316) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden builds rm <hash…>` (alias `remove`) removes cached builds by hash or a unique prefix (at least 6 characters), with their aliases, and forgets the install records at those hashes so the next `warden dev` / `warden app ensure` reinstalls on those devices. `--platform`, `--dry-run`, `--yes` and `--json` (`{ dryRun, removed, forgotInstalls }`) are supported. It asks first in a terminal, and refuses a prefix that matches several builds or a build being fetched or built right now.

- [#89](https://github.com/delacournz/warden/pull/89) [`14b0f3a`](https://github.com/delacournz/warden/commit/14b0f3a03ee885b287b634b8db552ded86eead34) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`: declining the `warden.config.ts` offer for an app read through `expo config` now writes the config to the repo's overlay under `~/.warden/projects/<repo>/` instead of skipping it, so later starts (from any worktree or branch of the same repo) skip the `expo config` call without a file in the checkout. A monorepo app gets `root` set to its path from the checkout. A `warden.config.ts` in the repo always wins over the overlay one.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` draws a dashboard on an interactive terminal: task rows on the left (claim device, show simulator, dev build, metro, dev client, session), the selected row's live output on the right, and Metro's own terminal in the metro row. `--no-tui` or `WARDEN_TUI=0` keeps the plain output; `--json`, pipes and CI are always plain.
  - The dashboard has two modes. List mode takes warden's keys; `Enter` or `i` on the metro row sends every key to Expo (`a`, `i`, `w`, `j`, `r`, `m`, `o`, `?`) until `Esc`, `Esc Esc` sends a literal Esc, and `Shift+PgUp` / `Shift+PgDn` scroll Metro's history. `?` lists the keys.
  - Action keys in list mode: `r` reload, `d` show the simulator, `o` open the dev client, `s` screenshot, `R` reinstall the dev build, `x` restart the simulator (iOS), `c` restart Metro with `--clear`, `l` stream device logs, `h` toggle the HUD, `q` quit and release.
  - The perf keys drive `warden perf` sessions from the dashboard: `p` starts and stops a session, `P` records every capture, `m` asks for a mark label, `f` reads frames (Android) and `g` shows the report. One session records per device, and `R` and `x` are refused while it does.
  - A perf HUD at the top right (terminals 100 columns or wider) shows CPU with a short history, memory (RSS on iOS, PSS on Android), fps and jank (Android), Metro's last bundle time and the recording clock. `--no-hud` turns it off and `--hud-interval <duration>` sets the sampling interval (default `1s`, minimum `200ms`).
  - Each dashboard session writes `warden.log`, `metro.log` and `shots/` under `$WARDEN_HOME/dev/<leaseId>/`; `warden gc` removes a session directory once its lease is gone and its files are 24 hours old.
  - `perf metrics --watch` on iOS costs ~1% of a core instead of ~16%: the app's pid is resolved once and each sample is one pid-scoped `ps`.

- [#91](https://github.com/delacournz/warden/pull/91) [`cea00ce`](https://github.com/delacournz/warden/commit/cea00cec65ce7714fca1a6e615b17e1790a4e7c2) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` holds one devtools connection to the app for the whole session (the dashboard's `devtools` row). It captures console lines, uncaught exceptions and `fetch` calls from launch, and `warden ui` devtools verbs read from it instead of opening their own connection. Without a dev session they connect directly as before.
  - `warden dev logs` reads Metro's output, classified as `bundle_start`, `bundle_done`, `bundle_failed`, `hmr`, `error`, `warn` and `info`, with file, line and code frame for bundle and transform errors. It takes `--since`, `--tail`, `--grep`, `--kind`, `--follow` and `--json`.
  - New `warden ui exceptions`, `warden ui route` and `warden ui devtools status|resume`. `warden ui logs` and `warden ui network` gain `--since`, `--level`, `--grep`, `--status` and `--limit`.
  - Exception and console stacks are symbolicated through Metro to source file and line, with Metro's code frame. Errors React Native reports through its exception handler count as exceptions.
  - `warden ui logpoint add <file:line[:col]> '<expression>'` logs a value every time a source line runs, without pausing the app or editing code. `--hits <n>` removes it after n hits. It comes with `logpoint list|rm|clear|hits`. Logpoints are set again after a reload and end with the session. They need the Fusebox debugger.
  - `warden perf js` records through the dev session's connection when `warden dev` runs. Other perf captures hand the connection back when they finish.
  - `warden perf js` hotspots now map to source on React Native apps, which load their bundle as `index.bundle//&…`.
  - When Chrome DevTools takes the app on a Metro that allows one debugger, the session's connection waits instead of taking it back. `warden ui devtools resume` reattaches.
  - `warden mcp` is an MCP server on stdio. Its tools are `dev_sessions`, `metro_logs`, `app_console`, `app_exceptions`, `app_network`, `app_eval`, `app_tree`, `app_route`, `app_reload`, `logpoint_add|hits|list|remove`, `profile_start|stop|status` and `devtools_status|resume`.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` (and every command that finds the project) works from a monorepo root without a `warden.config.ts`: when nothing is found upwards it looks below, in the package.json `workspaces` (else `apps/*` and `packages/*`). One app there is used and named; with several, `warden dev` asks which one, and a pipe gets the list and `--project <dir>`.
  - `warden dev` runs bare React Native apps. An app whose package.json depends on `react-native` but not `expo` gets its bundle ids from `ios/*.xcodeproj` and `android/app/build.gradle`, Metro as `react-native start` on the leased port, `react-native build-ios` / `build-android` as the default local build, and is relaunched against Metro (`-RCT_jsLocation` on iOS, port 8081 reversed on Android). No `expo-dev-client` is asked for. `c` restarts Metro with `--reset-cache`.
  - New `projects[].framework` (`"expo"` | `"react-native"`) in `warden.config.ts` overrides the guess from package.json.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` resolves an app whose config is code (`app.config.ts` / `.js` / `.mjs` / `.cjs`) without a bundle id in `app.json`: it runs `expo config --json --type public` in the app directory once and takes the bundle id, slug and scheme from the result, instead of stopping with "app.config.ts is dynamic". `--bundle-id` still overrides it and a `warden.config.ts` skips the call. The same applies to every command that finds the project this way (`warden app`, `warden e2e`, `warden run`).
  - `warden dev` checks the request and the app before it leases a device or opens the dashboard, and a failure there is one line with the fix on the terminal. With a person at the terminal each missing piece is offered: a package the dev-client run needs (`expo-dev-client`) is added and installed through the checkout's package manager (`yarn` / `pnpm` / `bunx` / `npx` `expo install`, from the nearest lockfile), and an app read through `expo config` can get a `warden.config.ts` with the resolved ids so later starts skip the call (run through the checkout's prettier when it has one). Without a terminal (`--json`, a pipe) the blocking issues are the error, each with its command.
  - The dashboard no longer swallows a failure: when the session never comes up, or Metro dies, warden's lines are printed to the terminal after the dashboard has closed, with the session log directory.
  - `warden init` names the install command for the checkout's package manager instead of always `bunx expo install`.

- [#97](https://github.com/delacournz/warden/pull/97) [`b590263`](https://github.com/delacournz/warden/commit/b5902636c9542d661f5272afb1c376e10872b404) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden e2e` and `warden ui record stop` no longer need bun installed: warden runs the specs with the bun built into its own binary. `WARDEN_BUN` still picks a different bun.

- [#85](https://github.com/delacournz/warden/pull/85) [`764ef1b`](https://github.com/delacournz/warden/commit/764ef1b576228227020bbc14f08e5ae70c5ff057) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - On iOS, `fill` pastes the text with one Cmd+V instead of typing every character, about 400 ms whatever its length. Secure fields are pasted too.
  - `locator.fill(text, { via: "paste" | "type" })` and `warden ui fill --via paste|type` choose how the text goes in; `paste` is the default and `type` keeps the old key-by-key typing. Android always types.
  - A paste that cannot be confirmed on the simulator pasteboard is typed in the same attempt, and the retry after a failed read-back always types, so a field that mangles a paste (a mask, a `maxLength`) still passes.
  - `warden ui record` writes `via: "type"` on a fill step that was typed, and the generated spec passes `{ via: "type" }`; existing recordings are unchanged.

- [#82](https://github.com/delacournz/warden/pull/82) [`84ae25c`](https://github.com/delacournz/warden/commit/84ae25c64e9e7cea91b3f2eb7c51e1fb4e477a04) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every iOS simulator warden creates boots already slim by default. `--slim` / `--no-slim` on `claim`, `run`, `dev`, `batch` and `e2e`, config `slim` (top-level, `e2e.<suite>.slim`, `batches.<name>.slim`) as `true | false | { except, keep }`, and `WARDEN_SLIM=0` choose per run, per suite or per machine.
  - The slim overrides are written to the simulator before its first boot, so clones come up slim with no per-daemon spawns. Once the sim is ready they are read back, and any drift is fixed live.
  - `warden sim slim --except <categories>` and `--keep <labels>` leave whole categories or single `com.apple.*` labels running. `warden sim profiles` lists the categories.
  - `warden sim measure [udid|--booted]` prints a booted simulator's real memory (summed `phys_footprint`) and its heaviest processes. `warden devices --mem` adds the figure to the device list.
  - `warden capacity` counts a slim simulator at 1792 MB and a stock one at 4096 MB (measured, up from 2048), so admission matches what simulators really use. `cost.ios.memMb` and `cost.ios.slimMemMb` override them.
  - `gamed` and `nanotimekitcompaniond` are no longer disabled, and are re-enabled on a simulator an older warden already slimmed.
  - A plain `warden claim` no longer restores a slimmed simulator. `warden sim slim --restore` does.

### Patch Changes

- [#90](https://github.com/delacournz/warden/pull/90) [`085f760`](https://github.com/delacournz/warden/commit/085f760ab3c77adecc690dbd272ca54edfcf7401) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden claim`, `warden run` and `warden dev` say what a claim is doing while it creates or boots a device (`creating …`, `… booting`, `… waiting until it is ready`), so `warden dev`'s claim row is no longer blank during a slow boot. A warm booted device is still claimed silently.

- [#99](https://github.com/delacournz/warden/pull/99) [`eb5f896`](https://github.com/delacournz/warden/commit/eb5f896f3d47bdc7a478e4b1a59362bbe9a67e7f) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - Every simulator warden shuts down now has its viewer window closed, not only the one `warden dev` stops on a clean exit: `warden release --shutdown`, SessionEnd, `warden batch`, `warden gc` (stale leases and idle sims) and the capacity gate's idle shutdown. On Xcode 27 this stops Device Hub windows offering "Start" from piling up after a `warden dev` session whose terminal was closed.

- [#90](https://github.com/delacournz/warden/pull/90) [`085f760`](https://github.com/delacournz/warden/commit/085f760ab3c77adecc690dbd272ca54edfcf7401) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`'s dashboard streams the local build's own output (`expo run:ios`, xcodebuild, Gradle) into the dev build row while it runs, instead of showing nothing until the build ends. The `R` reinstall action streams it into its row too. Plain output (`--no-tui`, `--json`, pipes, agents) is unchanged.

- [#94](https://github.com/delacournz/warden/pull/94) [`f672d27`](https://github.com/delacournz/warden/commit/f672d27add2101afa452375f85d34308755fd316) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev`, `warden app ensure` and `warden run --app` no longer cache a dev build made from a stale git-ignored `ios/` / `android/` dir. When the native fingerprint has changed since that dir was prebuilt (a new native dependency such as `expo-application`), or warden does not know which fingerprint it was prebuilt for, the local build removes it first so `expo prebuild` and `pod install` run again. Before, the build skipped both and linked none of the new native modules, so the dev client crashed with `Cannot find native module '<X>'`. A committed native dir, and a custom `build` command that does not run `expo prebuild` / `expo run:*`, are left as they are.

- [#93](https://github.com/delacournz/warden/pull/93) [`87ea71a`](https://github.com/delacournz/warden/commit/87ea71a6d73e8a5712757b44db63229e9e982cc1) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden claim` / `warden dev` no longer queue forever on macOS when the kernel reports memory pressure `warn` while plenty of memory is free: a kernel `warn` now holds the boot queue only when `memory_pressure` also shows under 25% free (`critical` still always holds). `warden capacity` shows the same reading.
  - `warden dev`'s dashboard shows the claim's progress under the claim row (`queued [#1](https://github.com/delacournz/warden/issues/1) of 1 (high) — memory pressure warn` and similar), instead of sitting on "preparing the ios dev build" with no output.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` boots a held simulator that is shut down (`--udid`, `--lease`, or the device lease an earlier session in the same shell left behind) and waits for it before installing, instead of opening Device Hub on a stopped sim and failing with "Unable to lookup in current state: Shutdown". It only boots a device under the session's own lease; a shut-down device that is not yours is an error naming it.

- [#98](https://github.com/delacournz/warden/pull/98) [`305da73`](https://github.com/delacournz/warden/commit/305da73f29e53db118bfb304fc8360f1cf725620) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` on iOS opens the Expo dev client without the dev menu's first-run onboarding sheet or the dev menu covering the app at launch. The dev menu stays reachable by shake, ⌃D or the floating button.
  - The warden skill says `warden dev ios` opens without the sheet, and that `warden ui open --relaunch` can still show it.

- [#88](https://github.com/delacournz/warden/pull/88) [`0f7b2a9`](https://github.com/delacournz/warden/commit/0f7b2a9be460541b2b38b3c5f8e4522d57412821) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden dev` shows the simulator it leased: once the device is held it brings the sim's window to the front, launching Device Hub (Xcode 27) or Simulator.app (Xcode ≤ 26) when no viewer is running, instead of leaving the window behind other apps or never opening one. `--headless` skips it; a viewer that can't be opened is a warning, not a failure.
  - `warden dev` shuts the simulator it booted down when it ends (Metro exits, Ctrl-C, a kill), and closes its Device Hub / Simulator.app window, instead of leaving it running until `warden gc` with a window behind. A sim that was already booted when leased, or one given with `--udid` / `--lease`, is left on. `--no-shutdown` keeps dev's own sim booted.
  - `warden dev` and `warden run` treat the terminal going away (SIGHUP) like Ctrl-C: the child is stopped and the leases released.

- [#81](https://github.com/delacournz/warden/pull/81) [`2960539`](https://github.com/delacournz/warden/commit/296053972bf3d48a736991b79a844ab9394adfa9) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - A `settle` no longer counts as input for the stable-frame rule: an action right after `app.open()` or a `device.settle()` that reported quiet trusts its one look instead of taking a second snapshot.
  - On iOS, an action whose look followed a tap or a key within 300 ms confirms that its element has stopped moving with one hit-test instead of a second whole-screen snapshot (not with `systemAlerts` set, where the full look is what finds an alert).

- [#85](https://github.com/delacournz/warden/pull/85) [`764ef1b`](https://github.com/delacournz/warden/commit/764ef1b576228227020bbc14f08e5ae70c5ff057) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS typing is about 2.6x faster: the default key pacing drops to 5 ms after a key, 20 ms hold and 50 ms before a repeated key, down from 30, 40 and 300 (about 38 ms per character instead of 99 on a local simulator).
  - `WARDEN_SIMD_PACE_MS`, `WARDEN_SIMD_HOLD_MS` and `WARDEN_SIMD_REPEAT_GAP_MS` and the `paceMs`, `holdMs` and `repeatGapMs` request fields still override the defaults.
  - The typing delays no longer go through the simulator library's timers, so a loaded host (a CI VM) stops stretching them into several times the requested pause.

- [#83](https://github.com/delacournz/warden/pull/83) [`51bb4ce`](https://github.com/delacournz/warden/commit/51bb4ceea6f7476c061e3852cea6d46215a4f27d) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `app.launch`, `app.terminate` and `app.openUrl` (every spec `app.open`, `device.openLink` and `warden ui open`) run inside the resident `warden-simd` helper instead of spawning `xcrun simctl` for each call: the helper already holds CoreSimulator, which every `simctl` process loaded again (about 0.13 CPU-s on the host per launch, roughly 40 % of warden's host CPU per bench rep). Launch arguments and environment reach the app as before, `relaunch: false` keeps a running instance, terminating an app that is not running is still a success, and the `driver.app.launch` span now carries `via` (`simd` or `simctl`) and the app's `pid`.
  - A helper built before these ops answers once and the driver falls back to `simctl` for the rest of the session (`[ios] this warden-simd predates the \`launch\` op …`in the log; restart it with`warden ui close --udid <udid>`or rebuild with`bun run --cwd packages/e2e native:build`). Install, uninstall, `isRunning`and`clearData`stay on`simctl`.

- [#96](https://github.com/delacournz/warden/pull/96) [`24d04ed`](https://github.com/delacournz/warden/commit/24d04edc9d26953e9b9c886a4811c1e68c9a4340) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - The warden agent skill (`warden skill install`, `warden install`) matches the current CLI: `warden builds`, `warden dev logs`, `warden mcp` tools, `warden perf` subcommands, `warden ui` devtools verbs and the flags added since 0.3 are documented, and stale defaults and error codes are corrected.

- [#100](https://github.com/delacournz/warden/pull/100) [`e1f6732`](https://github.com/delacournz/warden/commit/e1f673248319d03754135ebe95aac77a371e2250) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui open <bundleId> --metro <url>` on iOS launches the Expo dev client the way `warden dev` does: no dev menu onboarding sheet and no dev menu at launch. Your `--args` follow those flags.
- Updated dependencies []:
  - @delacour/warden-e2e@0.4.0

## 0.3.1

### Patch Changes

- [#74](https://github.com/delacournz/warden/pull/74) [`6b3ffea`](https://github.com/delacournz/warden/commit/6b3ffea079bcfc3ce73278b2d3f328899f449e46) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `bun run release <version>` asks npm about every package before writing the version or building: a version already published for all of them is reported and skipped without touching the tree, and packages that already have it are listed as skipped up front.
- Updated dependencies []:
  - @delacour/warden-e2e@0.3.1

## 0.3.0

### Minor Changes

- [#72](https://github.com/delacournz/warden/pull/72) [`b00d1e3`](https://github.com/delacournz/warden/commit/b00d1e38c77c7df31e5668b5906480f7246a432c) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden ui record start|note|undo|use|status|cancel|stop` ([#63](https://github.com/delacournz/warden/issues/63)): every `warden ui` action and query is journalled under `$WARDEN_HOME/ui/<udid>/`, and `stop` writes a typed `@delacour/warden-e2e` spec (or an exported helper) directly, then runs it once on the leased device (`--no-verify` skips). The journal is kept until a passing `stop` or a `cancel`, so you can `undo`, fix and `stop` again.
  - `record use` runs an exported helper on the device, then records an import and a call to it.
  - Generated specs use durable selectors only (testID > role+label > text); `snapshot -i` marks elements without one as `[no-id]`. Lints: `coords_target`, `text_only_selector`, `ambiguous_selector`, `unverified_navigation`, `empty_recording`.
  - Secrets typed through `WARDEN_UI_SECRET_<NAME>` never land in the spec; testIDs are merged into an ids module; `wait` / `is` / `get` become auto-waiting expects; `app.open({ wait: "quiet" })`.
  - Recordings reuse the suite's shared `test.use` options and emit `launch: "none"` when the recording or its helper opens the app itself.
  - `stop` prints the `specs.<id>` entries for `warden.config.ts` from the routes seen on a dev client (helper routes merged); it never edits the config.

### Patch Changes

- Updated dependencies []:
  - @delacour/warden-e2e@0.3.0

## 0.2.0

### Minor Changes

- [#58](https://github.com/delacournz/warden/pull/58) [`03136f3`](https://github.com/delacournz/warden/commit/03136f3b414cfce9849183b7b522ffc52086d677) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - `warden-simd` links idb v1.7.7, whose typed bridge answers replace the generic frame decode: the helper's CPU per accessibility read drops by about three quarters (host 9.12 → 3.79 CPU-seconds per bench rep on EAS `macos-large` with the equivalent patch), memory unchanged. A guest that stops answering now surfaces as `E_TIMEOUT` with the seconds allowed.
  - `WARDEN_SIMD_TIMEOUT` (a duration, e.g. `60s`) sets the per-request timeout of the helper client `warden ui` and the e2e runner connect with; the default stays 10 s.
  - `warden e2e` / `warden dev` honour the core `eas: false` opt-out and never call eas-cli when it is set.
  - Golden settle probe works without a GUI launchd session (hosted workers, ssh).

### Patch Changes

- [#69](https://github.com/delacournz/warden/pull/69) [`1d39a21`](https://github.com/delacournz/warden/commit/1d39a21a0f24e3cef6c44130f8d948c3250d1620) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - - iOS `typeText` with characters the HID keyboard cannot type (`café`, emoji, CJK) pastes the right text again on Xcode 27.1: the simulator pasteboard is written through `devicectl device pasteboard copy` (falling back to `simctl pbcopy`) and confirmed with `pbpaste` before the paste keystroke. `simctl pbcopy` exits 0 there without changing the pasteboard, so the field used to receive whatever the Mac had copied last. An unconfirmed write is now `E_IO` and nothing is pasted.
- Updated dependencies []:
  - @delacour/warden-e2e@0.2.0

## 0.1.2

### Patch Changes

- [#64](https://github.com/delacournz/warden/pull/64) [`2569b9c`](https://github.com/delacournz/warden/commit/2569b9cf7cbadc24b9ca0830233d420f78d1e6ba) Thanks [@UrbanChrisy](https://github.com/UrbanChrisy)! - Releases now flow through a changesets "Version Packages" PR into `develop`; merging it fast-forwards `main`, which deploys the docs and publishes the npm packages together.
- Updated dependencies []:
  - @delacour/warden-e2e@0.1.2
