---
"@delacour/warden": minor
---

Physical devices: lease, drive and test real Android phones and iPhones/iPads.

**Claiming**
- `warden claim --physical` leases a connected phone or tablet; `--serial <serial...>` (Android) and `--udid <udid...>` (iOS) name the devices and imply `--physical`. A plain `warden claim` never takes a physical device, even with `--adopt`.
- `--physical` is rejected together with `--count`, `--max`, `--slim`, `--headless`, `--runtime` and `--adopt`; `--serial` / `--udid` are rejected on the wrong platform. Leases and `warden claim --json` carry a `physical` field.
- A physical device is never booted, created, shut down, erased or slimmed: `warden release --shutdown` and `warden gc` leave it running, and it costs nothing in host capacity.
- An iPhone or iPad is picked only when it is reachable: its tunnel is connected, it is wired, or `devicectl device info lockState` answers within 5 s (20 s for a phone named with `--udid` or `physical.ids`; probes run in parallel). An answer means reachable even when the phone is locked: `warden devices` and `warden doctor` show it as locked. Devices that are listed as available but are offline (an iPad in a drawer) are shown with a reason and never auto-picked. An Android phone that is `unauthorized` or `offline` is never auto-picked either.
- Naming an unusable device with `--udid` / `--serial` fails `device_offline` with the reason and what to do.
- `physical: { allow: [...] }` in `warden.config.ts` and `WARDEN_PHYSICAL_IDS` (comma-separated, wins over the config) limit what an id-less `--physical` claim may pick. Naming a device with `--udid` / `--serial` still works for any device. A `warden.config` that cannot be read fails the claim instead of ignoring the list.
- An id-less `--physical` claim with more than one usable phone (ready, reachable, unleased, on the allowlist) no longer picks silently, in `warden claim`, `warden ui --claim`, `warden e2e`, `warden run` and `warden batch`. In a terminal a picker lists name, model, OS version and transport (cancel = `Aborted.`, exit 1); otherwise, or with `--json`, it fails `ambiguous_device` (exit 2) with `error.details.candidates` and the hint to pass `--udid` / `--serial` or set `WARDEN_PHYSICAL_IDS`. The choice is made once before any lease, build or job; one candidate is still picked without asking.

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
