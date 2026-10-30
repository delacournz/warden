# Physical phones and tablets

Real Android phones and iPhones/iPads are leased like sims, but only on request. Everything here is opt-in: a plain `warden claim` never takes one, even with `--adopt`.

## Pick and claim

| Need | Command |
|---|---|
| what warden sees, why one is skipped | `warden devices --physical [ios\|android] [--json]` (rows: `kind`, `transport`, `hint`) |
| any usable phone | `warden claim android --physical --json` · `warden claim ios --physical --json` |
| these exact devices | `--serial <adb serial…>` (Android, `ip:port` for wireless) · `--udid <CoreDevice UDID…>` (iOS); each implies `--physical` |
| drive / test | `warden ui open --claim --physical` · `warden ui … --udid <id>` · `warden e2e <suite> --physical\|--serial\|--udid` (also `run`, `batch`) |

Rejected with `--physical`: `--count --max --slim --headless --runtime --adopt`. `--serial` is Android only, `--udid` iOS only.

### Several usable devices

An id-less physical claim (`claim --physical`, `ui --claim --physical`, `e2e` / `run` / `batch` with `--physical` or suite `physical: true`) never silently picks between phones. Usable = ready, reachable, not leased, on the allowlist (below).

| Candidates | Result |
|---|---|
| exactly one | picked, as before |
| several, human terminal (not `--json`) | a picker (name, model, OS, transport); cancel = `Aborted.`, exit 1 |
| several, otherwise (agent, `--json`, `ui`) | exit 2 `ambiguous_device`; `--json`: `error.details.candidates: [{id, name, platform, model, osVersion, transport}]`, hint `pass --udid <id> (iOS) / --serial <id> (Android), or set WARDEN_PHYSICAL_IDS`; text: a table on stderr |

Decided once, before any lease, build or job. A picked device is then named, so a device taken in between fails the claim.

**As an agent:** on `ambiguous_device` ask the user which device, listing the candidate names, unless they already said any device is fine. Then claim with `--udid <id>` (iOS) / `--serial <id>` (Android) and say which you picked. Never pick a device the user said is someone else's. To make a run unambiguous for good, set `WARDEN_PHYSICAL_IDS` or `physical.allow`.

## What counts as usable

- Android: adb state `device`. `unauthorized` and `offline` are listed with a hint and never picked.
- iOS: paired, Developer Mode on, and **reachable**: tunnel connected, wired, or a bounded `devicectl device info lockState` answers (5 s; 20 s for a phone you named with `--udid` / `physical.ids`). An answer means reachable even when locked (`passcodeRequired`): `warden devices` shows a `locked` hint. `devicectl` lists every device ever paired (an iPad in a drawer too) as available, so an unreachable one is `offline: <reason>` in `warden devices` and is never auto-picked.
- Naming an unusable device (`--udid`/`--serial`) fails the claim with `device_offline: <id> (<name>): <label>: <hint>` after `--wait` (default 30m); until then it prints `waiting for <id> (<name>): <reason> (up to …)` and `still waiting …` about every 30 s. Add `--no-wait` to fail at once.
- **Locked iPhone:** before any lease (`claim`, `run`, `batch`, `e2e`, `ui --claim`), warden reads `lockState` of the phone it is about to take. Locked: stderr `<name> is locked: unlock it to continue (waiting up to 2m)`, poll every 10 s, a progress line about every 30 s, continue when unlocked. Still locked after 2 m, or `--no-wait`: `device_locked` (exit 2, hint `unlock the phone, then retry`; `--json` error code `device_locked`). No lease is held while waiting. An id-less claim waits only when exactly one phone qualifies. Android phones are not checked at claim time (a PIN keyguard fails `E_DEVICE_LOCKED` once `warden ui` drives it).

## Allowlist

When other people's devices share the machine, restrict an id-less `--physical` claim:

| Where | Form |
|---|---|
| env (wins) | `WARDEN_PHYSICAL_IDS=00008140-000A0B0C0D0E0F10,R5CT123ABC` |
| `warden.config.ts` | `physical: { allow: ["…", "…"] }` |

- Applies to claim, `ui --claim --physical`, `e2e|run|batch --physical` (all go through the claim).
- Naming a device with `--udid` / `--serial` beats the list. A list that matches nothing connected waits, then fails `no free ready physical <platform> device in the allowlist (…)`.
- An unreadable `warden.config` fails the claim instead of ignoring the list. There is no machine-wide file: use the env var in the shell profile.
- Agents: never claim a device that is not on the list unless the user named it.

## Never

Boot, create, shut down, erase or slim a phone; `release --shutdown` and `gc` leave it. No host capacity. `uninstall` / `clearData` only on `WARDEN_BUNDLE_ID` and packages warden installed (`E_REFUSED`, `physical_protected`). Never unlock a phone. Never kill another tool's `xcodebuild` (`device_busy`). No device conditions or settings (`ui network|location|clock|permission|timezone|locale|a11y|battery|memory-warning|push`, `device.network` …): `E_UNSUPPORTED`, troubleshooting 49; a `physical` suite refuses `conditions`.

## iPhone specifics

- Signing team: `WARDEN_IOS_TEAM_ID` > `ios.teamId` > the keychain when it holds one team; several → `ios_team_ambiguous`.
- Runner build failures carry a code: `no_account no_team ios_team_ambiguous bundle_id_taken device_locked developer_mode_off runner_untrusted ui_automation_disabled device_busy ddi_unavailable unsupported_os build_failed` (see troubleshooting 75, 74).
- Single finger only: `pinch rotate gesture press shake press back` → `E_UNSUPPORTED`. Specs: `test(t, { requires: ["pinch"] }, …)` skips on a phone.
- The runner host stays resident (10 min idle). When the runner changes (new warden, edited `packages/e2e/native/ios-runner`) the next `warden ui` / `warden e2e` replaces it by itself (stderr: `runner changed; restarting the iPhone runner host`); no manual `__ios-runner-restart`. If the phone is leased to another session it fails `device_busy` (exit 2) and leaves their host alone: wait or release, then run again.
- Speed: tap ≈ 0.8 s, snapshot 0.15–0.3 s, launch ≈ 2.5 s. Do not shorten waits to compensate; use `wait`.
- No app install through warden yet (`--app` fails before leasing): install the app by hand.
- Needs on the phone: Developer Mode, trusted computer and developer certificate, Enable UI Automation, unlocked while the run starts.

## Android specifics

- USB debugging accepted for this computer; PIN/pattern keyguard fails `E_DEVICE_LOCKED`.
- Install kind: `dev` or `release` (a `simulator` build is x86_64: `abi_mismatch`).
- The "Save password to Google Password Manager?" sheet is closed with Back (`test.use({ systemAlerts })` / `device.alert`); warden never presses Never/Continue.
- Two adb servers make phones flap: `adb kill-server`, keep one.

## Privacy

Screenshots, snapshots, recordings and `results.jsonl` capture personal content from the phone. Prefer a test device and test accounts; do not paste evidence from a personal phone into issues, PRs or chat.

## Diagnose

`warden doctor` adds `ios-team`, `ios-devices`, `ios-runner` and `android-devices` rows only when a phone or a team exists. Error → fix table: `troubleshooting.md` rows 68–78 and the physical rows after them.
