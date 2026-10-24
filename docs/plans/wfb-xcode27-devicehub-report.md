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
