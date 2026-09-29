---
name: warden
description: Machine-wide leasing of iOS simulators, Android emulators and ports across agents, worktrees and users. Use before booting, choosing or interacting with any simulator/emulator (argent, simctl, adb, e2e scripts), when picking a dev-server port, or when installing a dev build on a device.
---

# warden

Several agents and humans share this machine's simulators, emulators and ports. `warden` hands out exclusive leases so nobody drives someone else's device.

## Rules

- **Claim before use.** `warden claim ios --json` (or `android`) → use the returned `udid` / `serial` for every argent / simctl / adb call. Never pick a device from `list-devices` or `simctl list` on your own.
- **Never touch a booted device you did not claim** — it belongs to another session. Do not shut it down, erase it, or install on it.
- A Claude hook blocks argent calls on devices leased by other sessions; if blocked, run `warden claim` and switch to the returned device.
- **Release when done:** `warden release --mine` (add `--shutdown` to stop sims warden created).

## Commands

| Need | Command |
|------|---------|
| one sim / emulator | `warden claim ios --json` · `warden claim android --json` |
| N devices + ports for an e2e script (auto-release on exit) | `warden run ios --count N --port 8091:20 -- <cmd>` (env: `WARDEN_UDIDS`, `WARDEN_UDID_0…`, `WARDEN_PORT_0…`) |
| a free port | `warden port claim --json` |
| dev build installed on the device | `warden app ensure ios --udid <udid> --json` |
| who holds what | `warden ls` |
| all sims / emulators (booted or not) + who leases them | `warden devices` (alias `warden list`) |
| is this device free / mine? | `warden check --udid <udid>` (exit 2 = someone else's) |
| keep a long lease alive | `warden heartbeat --mine` |
| reclaim dead leases | `warden gc` |
| setup problems | `warden doctor` |

Leases expire after 30 min without a heartbeat (each argent call through the hook refreshes it).
