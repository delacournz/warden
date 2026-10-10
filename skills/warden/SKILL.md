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
- **A bare `warden claim` lasts ~5 min** (agents; `--ttl` overrides) and nothing refreshes it by itself. Only a wrapper (`warden dev` / `run` / `batch` / `e2e`, which hold by pid + 30 s heartbeat) or an explicit `warden heartbeat` keeps a device longer. Stale devices are reclaimed (gc shuts a sim down no sooner than 10 min after its lease went stale, and never while an app is running on it).
- **Release when done:** `warden release <leaseId…>` (add `--shutdown` to stop sims warden created). Subagents never call `release --mine` (it frees the parent's leases too): release by id, or claim with `--label <x>` and `release --mine --label <x>`.

## Commands

| Need | Command |
|------|---------|
| one sim / emulator | `warden claim ios --json` · `warden claim android --json` |
| N devices + ports for an e2e script (auto-release on exit) | `warden run ios --count N --port 8091:20 -- <cmd>` (env: `WARDEN_UDIDS`, `WARDEN_UDID_0…`, `WARDEN_PORT_0…`) |
| A list of independent jobs (flows, scenes) across N devices | `warden batch ios --count N --jobs-from <file\|-> [--serve <cmd> --serve-ready tcp:PORT] -- <cmd {job} {udid}>` (per job: `WARDEN_UDID`, `WARDEN_JOB`, `WARDEN_JOB_SEQ`; a failed job leaves `<log>.png` next to its log, path in `batch.json`) |
| a batch saved in `warden.config.ts` `batches` | `warden batch <preset> [flags override it] [-- <cmd> overrides its cmd]` |
| which e2e flows a change needs (git diff → import graph) | `warden affected [suite] --base main --explain` (`--json`, `--strict`) |
| run only those flows on leased devices; exit 1 if a required one fails | `warden e2e [suite] --base main --count N` (`--dry-run` to preview; `--all` every flow; `--flows a,b` exactly those, no diff; suite `include`/`exclude` flow-id globs, `scope` + `unmatched: "run-all"` fail-safe). Suite fields `project` `ports` `env` `serve` `serveReady` `serveTimeout` `app` mirror a batch preset; `setup` runs once per device before its first flow (failing device is dropped; `logs/setup-<worker>.log`) |
| fewer background daemons on a booted sim (RAM/CPU with many sims) | `warden sim slim <udid>\|--booted [--dry-run] [--restore]` (e2e suite: `"slim": true`) |
| a free port | `warden port claim --json` |
| dev build installed on the device | `warden app ensure ios --udid <udid> --json` (`--variant dev\|e2e`) |
| run the app in a worktree (instead of `expo run:ios`) | `warden dev ios [--udid <udid>] [-- <expo start args>]` — reuses the cached build for the native fingerprint, starts Metro on a leased port, opens the dev client |
| duplicate a shut-down sim (fast, no first boot) | `warden clone <udid\|name> [--name x]` |
| pre-build the golden image new sims clone from | `warden golden ensure --profile iphone-17` |
| who holds what | `warden ls` |
| all sims / emulators (booted or not) + who leases them | `warden devices` (alias `warden list`) |
| is this device free / mine? | `warden check --udid <udid>` (exit 2 = someone else's) |
| keep a bare-claim lease alive | `warden heartbeat <leaseId…>` (or `--mine`); better, use a wrapper |
| reclaim dead leases | `warden gc` |
| sim + runtime disk usage; delete idle/broken warden sims | `warden sims` (read-only, runtimes too) · `warden sims prune --dry-run` then `--yes` (`--max-size 40G` for a budget) |
| delete sims of any owner (user-picked; same rules as audit) | `warden sims delete` (menu, suggestions pre-ticked) · `--suggested --dry-run` to preview |
| setup problems | `warden doctor` |
| `warden` not installed | `npm i -g @delacour/warden && warden install` (one-shot: `npx @delacour/warden install`) |
| update warden | `warden update` (`--check` to only look; for npm/bun installs it prints the upgrade command) |

Leases expire without a heartbeat: ~5 min for a bare agent `warden claim`, 30 min otherwise. Wrappers heartbeat for you.

## agent-device

1. `warden claim ios --json` (or `android`) → pass the returned device explicitly on every call: `--platform ios --udid <udid>` (Android: `--serial <serial>`). Never let agent-device pick; with several booted devices it refuses to guess.
2. Short check: do it within the ~5 min of the bare claim, or `warden heartbeat <leaseId>` while you work.
3. Longer exploration: claim, then run `warden dev ios --udid <udid>` (add `--profile X` to let it claim instead) in the background. It holds the device and a Metro port and opens the dev client; keep targeting the udid, and stop it (Ctrl-C) to release what it leased.
4. Subagents: release with `warden release <leaseId>` or `--mine --label <x>`, never bare `--mine`.
