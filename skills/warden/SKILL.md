---
name: warden
description: Machine-wide leasing of iOS simulators, Android emulators, ports and app builds, plus warden's own e2e stack. Use before booting, choosing or touching any simulator/emulator, picking a dev-server port, installing a dev build, driving an app by hand (warden ui), writing or running *.e2e.ts specs (@delacour/warden-e2e), editing warden.config.ts e2e suites, or reading e2e evidence. argent, agent-device and tester.army e2e are retired.
---

# warden

Several agents and humans share this machine's simulators and emulators; warden leases them. `warden ui` and `@delacour/warden-e2e` are the only ways to drive a device.

## Rules

- **Claim before use.** `warden claim ios --json` (or `android`) → use the returned `udid` / `serial` on every call. Never pick a device from `simctl list`, `adb devices` or a tool's device list.
- **Never touch a booted device you did not claim.** No shutdown, erase, install, tap. Nothing intercepts simctl/adb for you any more (no PreToolUse hook): the lease check lives in `warden ui`, `warden check`, `sim slim` only.
- **Drive by hand with `warden ui` only.** argent, agent-device, tester.army `e2e`/`@e2e-dev/mobile` are retired; do not call their tools or skills even if installed. Raw `simctl`/`adb` only for what `warden ui` cannot do, and only on your leased udid.
- **Anything that must keep passing is a spec** (`*.e2e.ts`, `@delacour/warden-e2e`) run by `warden e2e <suite>`. Never start Metro or export `WARDEN_*` by hand for a suite.
- **Xcode 27 MCP is not a device path.** `xcrun mcpbridge` / `xcrun mcp-server` are fine for build, test, previews and docs. Its `DeviceInteraction*` tools (and Apple's exported device-interaction skill) drive any booted sim and bypass leases: use them only on a udid you `warden claim`ed, end the session (`DeviceInteractionEndSession`) before `warden release`, and never run `mcp-server enable --unsafe-always-allow-all-agents`.
- **Release when done.** `warden ui close --release` or `warden release <leaseId> [--shutdown]`. A bare `warden claim` by an agent lasts 5 min with no auto-refresh (every `warden ui` call heartbeats it; `warden dev`/`run`/`batch`/`e2e` hold by pid + 30 s heartbeat; else `warden heartbeat <leaseId>`). Subagents never run bare `release --mine` (frees the parent's leases): release by id, or claim `--label x` and `release --mine --label x`.

## Which path

Open the reference file for details before acting; this file only routes.

| You want to | Read |
|---|---|
| explore / verify an app by hand (snapshot, tap, type, wait, record) | [references/ui.md](references/ui.md) |
| write or fix a `*.e2e.ts` spec, helpers, testIDs, read failure artifacts | [references/specs.md](references/specs.md) |
| run flows (`warden e2e`, `affected`), suite config, batch dir, `run`/`batch` scripts | [references/suites.md](references/suites.md) |
| an error code, a dropped tap, a sheet, a stale helper, Metro refused | [references/troubleshooting.md](references/troubleshooting.md) |

## Quick reference

| Need | Command |
|---|---|
| one sim / emulator | `warden claim ios --json` · `warden claim android --json` (`--headless`, `--label x`, `--ttl 30m`) |
| set a new Expo app up for warden | `warden init --bundle-id <id>` → bundle id into `app.json`, `warden.config.ts`, `e2e/smoke.e2e.ts`; names packages to install (`expo-dev-client`, `@delacour/warden-e2e`), installs nothing |
| run the app in this worktree (replaces `expo run:ios`) | `warden dev ios --json` (platform defaults to ios) → first stdout line `{ udid, port, metroUrl, leaseIds }`; checks bundle id + `expo-dev-client` first; owns Metro on a leased port, refuses another checkout's Metro, opens the dev client; Ctrl-C releases |
| dev build on a device | `warden app ensure ios --udid <udid> --json [--variant dev\|e2e]` |
| the flows a change needs | `warden affected [suite] --base main --explain [--strict] [--json]` |
| run them on leased devices | `warden e2e [suite] [--base main\|--all\|--flows a,b] [--count N] [--dry-run] [--devices all] [--no-shutdown] [--no-warm] [--headless] [--report f]` |
| N devices + ports for a script | `warden run ios --count N --port 8091:20 [--app] -- <cmd>` |
| independent jobs over N devices | `warden batch ios\|<preset> --count N --jobs-from <file\|-> -- <cmd {job} {udid}>` |
| a free port | `warden port claim --json` (`--from 8091 --span 20`) |
| who holds what / all devices | `warden ls` · `warden devices` (`list`) |
| is this device free or mine | `warden check --udid <udid>` (exit 2 = someone else's) |
| keep a bare lease alive | `warden heartbeat <leaseId…>` (prefer a wrapper) |
| device misbehaving | `warden release <leaseId> --bad "<why>"` (undo: `warden sim unquarantine <udid>`) |
| fewer daemons on a sim | `warden sim slim <udid>\|--booted [--dry-run\|--restore]` |
| clone / golden / disk | `warden clone <udid\|name>` · `warden golden ensure --profile iphone-17` · `warden sims` (`prune --dry-run`, then `--yes`) |
| reclaim dead leases | `warden gc` (auto every 10 min; never deletes, never touches foreign devices) |
| setup / helper problems | `warden doctor [--fetch-helper]` |
| install / update | `npm i -g @delacour/warden && warden install` · `warden update [--check]` · skill: `warden skill install` |

By hand, specs need the preload: `bun test --preload @delacour/warden-e2e/preload <file>`.

## Facts

- Lease TTL 30 min; a bare agent claim 5 min.
- gc shuts a stale sim down 10+ min after it went stale, and never while a non-Apple app is in the foreground.
- warden only creates, shuts down and erases `warden-<profile>-N` sims; `--adopt` opts a foreign device in.
- The SessionEnd hook releases and shuts down what the session booted; `/clear` keeps sims up.
- Codex: set `WARDEN_SESSION_ID`, or leases count as the shell's user leases.
- A failed `warden e2e` leaves sims booted for inspection.

## Done

- `warden ui close --release`
- `warden release <leaseId> [--shutdown]`
- Subagents: release by id, or `release --mine --label x`.
