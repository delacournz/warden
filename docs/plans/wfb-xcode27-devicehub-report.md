# WFB-XCODE27-DEVICEHUB — report

Branch `feature/wfb-xcode27-devicehub`, commit `610b7938` (🐛 fix(cli): detect Xcode 27 Device Hub…). Not pushed, no PR.

## Problem

Xcode 27 drops Simulator.app for **Device Hub** (`Xcode.app/Contents/Applications/DeviceHub.app`, bundle `com.apple.dt.Devices`, process `DeviceHub`): one window + device list instead of one window per sim. `--headless` (close per-sim windows, flip `DetachOnWindowClose`) and post-claim tiling (`warden arrange`, auto-arrange) assumed Simulator.app.

## Detection logic

`detectSimViewer(exec)` in `apps/cli/src/sim-windows.ts` → `{ kind: "simulator" | "device-hub" | "none" }`:

1. `pgrep -xq Simulator` — any exit ≠ 1 (match, or pgrep missing/failing) → `simulator` (old behaviour preserved: "unsure → ask osascript").
2. else `pgrep -xq DeviceHub` exit 0 → `device-hub`.
3. else `none`.

By **running process, not Xcode version** — a Mac with Xcode 26 + 27 side by side still tiles/closes Simulator.app windows. Simulator wins if both run.

Effects:
- `arrangeSimWindows` → `device-hub`/`none`: no osascript, returns `{ arranged: [], viewer }`. `warden arrange` prints "Device Hub (Xcode 27) shows every simulator in one window: nothing to tile"; `--json` adds `viewer`.
- `startHideSimWindows` → `leasedTitles` returns `[]` before `holdDetachPref`, so Device Hub's window is never closed/moved/launched and `com.apple.iphonesimulator DetachOnWindowClose` is never written.
- Booting unchanged (`simctl boot` is windowless on every Xcode).

Docs: `apps/docs/content/docs/guides/headless.mdx` (Device Hub section, `devices://device/open?id=<udid>` watch link, input caveat), `reference/cli.mdx` (arrange), `skills/warden/references/suites.md`.

## Verification (2026-10-23, after Orca crash)

- Tree clean; `bun test apps/cli/src/sim-windows.test.ts apps/cli/src/commands/arrange.test.ts` 67 pass.
- `bun run --cwd apps/cli test` 1577 pass / 1 skip / 0 fail.
- `bun run typecheck` ✅, `bun run check` ✅.
- Host is **Xcode 26.6** — nothing ran against real Xcode 27 / Device Hub.

## Assumed vs verified

| Claim | Status |
|---|---|
| Process name `DeviceHub` | **assumed** (from Xcode 27 release notes/reports; not observed) |
| Bundle path/id `DeviceHub.app` / `com.apple.dt.Devices` | assumed (docs only, code doesn't use them) |
| Single window for all sims, no per-device window | assumed |
| `devices://device/open?id=<udid>` URL scheme | assumed |
| Device Hub hijacks touch input after manual interaction until reboot | assumed (reported, not reproduced) |
| `simctl boot` windowless on Xcode 27 | assumed (true ≤ 26) |
| Simulator.app path unchanged on Xcode ≤ 26 | **verified** by unit tests + existing suite; host Xcode 26.6 |
| Detection branching, no pref write / no osascript under Device Hub | verified by unit tests (injected exec) |

## Steps to verify on Xcode 27

Host with Xcode 27 selected (`xcode-select -p`), warden from this branch (`bun run cli:link`).

1. Process name: open Device Hub (Xcode ▸ Open Developer Tool, or `open "devices://"`), then `pgrep -lx DeviceHub` → must print a pid. If empty, `ps -axo comm | grep -i device` and fix the name in `detectSimViewer` + tests.
2. Confirm no Simulator.app: `pgrep -lx Simulator` → empty.
3. Baseline pref: `defaults read com.apple.iphonesimulator DetachOnWindowClose` (note value / "does not exist").
4. Tiling: `warden claim ios --json` (note udid + leaseId) → no window moved; `warden arrange --json` → `{"arranged":[],"viewer":"device-hub"}`.
5. Headless: `warden claim ios --headless --json` → Device Hub window stays open & untouched, sim still `Booted` (`xcrun simctl list devices | grep <udid>`), no warn lines.
6. Pref untouched: re-run step 3 → same as baseline.
7. Watch link: `open "devices://device/open?id=<udid>"` → Device Hub selects that sim.
8. e2e: `warden e2e example --headless` (iOS) passes with Device Hub open and with it quit.
9. Input caveat (optional, sacrificial sim): tap in Device Hub, then `warden ui open` + `press` on that udid — record whether warden taps are dropped and whether quitting Device Hub restores them.
10. Release: `warden release <leaseId>` per lease.
11. Side-by-side: with Xcode 26 Simulator.app also running, `warden arrange --json` → `viewer: "simulator"`, windows tiled.

## Open questions

1. Real process name — `DeviceHub` or something else (e.g. `Device Hub`, `Devices`)? Step 1 decides.
2. Does Device Hub expose per-device windows via System Events (pop-out)? If yes, tiling/headless could target them.
3. Input-capture bug: should warden warn when Device Hub is running during an e2e run, or refuse? Currently docs-only.
4. Does `simctl boot` on Xcode 27 auto-open Device Hub? If so, headless needs a different strategy.
5. Should detection also check `xcode-select` version to give a clearer message when neither viewer runs?

## Verified on Xcode 27.1 (27A9275), 2026-10-24

Host: Xcode 27.1 (27A9275), `/Applications/Xcode.app`, Device Hub already open. Warden-created sims only; leases released by id.

| Step | Result |
|---|---|
| 1 process name | `pgrep -lx DeviceHub` → pid; name **confirmed** `DeviceHub` |
| 2 no Simulator.app | `pgrep -lx Simulator` empty |
| 3 baseline pref | `DetachOnWindowClose` does not exist |
| 4 tiling | `warden claim ios` moved nothing; `warden arrange --json` → `{"arranged":[],"viewer":"device-hub"}` |
| 5 headless | `warden claim ios --headless` left Device Hub untouched, sim still `Booted`, no warnings |
| 6 pref untouched | still does not exist |
| 7 watch link | `open "devices://device/open?id=<udid>"` **works**: Device Hub opens/focuses that sim's window (System Events window list reorders). Scheme confirmed |
| 8 e2e `--headless` | Device Hub open: `onboarding` **passes**. Device Hub quit while the sim stayed booted: **fails**, `tap failed: E_HID: The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated`, again on retry; after `simctl shutdown` of that sim, a fresh boot with Device Hub still quit **passes**. Device Hub was relaunched afterwards |

Findings:
- Device Hub **does** expose one System Events window per device (`<name> – iOS <ver>`), so per-device tiling/closing is possible later (open question 2).
- Quitting Device Hub invalidates the HID digitizer connection of sims it had open; they need a reboot before warden taps work. A candidate for `warden doctor`/`E_HID` hint text (open question 3).
- Not exercised: step 9 (manual tap in Device Hub), step 11 (Xcode 26 Simulator.app side by side), whether `simctl boot` itself opens Device Hub (open question 4).
- `warden-simd` needed an `@executable_path` rpath on Xcode 27.1 (fixed in `57e09cbd`).
