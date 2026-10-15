---
name: warden
description: Machine-wide leasing of iOS simulators, Android emulators and ports across agents, worktrees and users. Use before booting, choosing or interacting with any simulator/emulator (simctl, adb, warden ui, e2e scripts), when picking a dev-server port, or when installing a dev build on a device.
---

# warden

Several agents and humans share this machine's simulators, emulators and ports. `warden` hands out exclusive leases so nobody drives someone else's device.

## Rules

- **Claim before use.** `warden claim ios --json` (or `android`) → use the returned `udid` / `serial` for every simctl / adb / `warden ui` call. Never pick a device from `list-devices` or `simctl list` on your own.
- **Never touch a booted device you did not claim** — it belongs to another session. Do not shut it down, erase it, or install on it.
- `warden ui` refuses a device another session leased; if refused, run `warden claim` and switch to the returned device.
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
| run only those flows on leased devices; exit 1 if a required one fails | `warden e2e [suite] --base main --count N` (`--dry-run` to preview; `--all` every flow; `--flows a,b` exactly those, no diff; suite `include`/`exclude` flow-id globs, `scope` + `unmatched: "run-all"` fail-safe). Suite fields `project` `ports` `env` `serve` `serveReady` `serveTimeout` `app` mirror a batch preset; `setup` runs once per device before its first flow (failing device is dropped; `logs/setup-<worker>.log`). `metro: {}` = warden starts + verifies its own Metro (`WARDEN_METRO_URL`, `WARDEN_PORT`; never another worktree's); `devices: [...]` legs (`--devices all`); `mode: "single"` = one runner for the whole pool; `jobTimeoutMs` kills a hung runner. Never start Metro or export device / port env vars by hand for a suite: run `warden e2e <suite>` |
| no simulator windows during a run (even with Simulator.app open) | `--headless` on `claim` / `run` / `batch` / `e2e` / `dev`, or `headless: true` on the suite / preset / config top level, or `WARDEN_HEADLESS=1` (not `dev`). Closes only this run's sims' windows (never launches Simulator.app); `--no-headless` overrides. Android is always headless |
| fewer background daemons on a booted sim (RAM/CPU with many sims) | `warden sim slim <udid>\|--booted [--dry-run] [--restore]` (e2e suite: `"slim": true`) |
| iOS driver helpers up before the first flow | e2e suite `warmDrivers` (default on; `--no-warm` skips): every leased device's `warden-simd` helper starts in parallel after setup and takes one snapshot; jobs get `WARDEN_SIMD_SOCKET`; log `logs/warm-<worker>.log` |
| the spec runner: how flows run | `*.e2e.ts` specs from `@delacour/warden-e2e` (`bun add -d @delacour/warden-e2e`, same version as warden) run by `bun test`; suite `spec: { bundleId, launchArgs, timeout, actionTimeout, assertionTimeout }` (the removed `runner` key fails validation). By hand: `WARDEN_UDID=<udid> WARDEN_BUNDLE_ID=<id> bun test e2e/x.e2e.ts`. Evidence per failed test: `<batchDir>/e2e/<worker>-<seq>/<flow>/<test>/{failure.png,screen-at-failure.txt,trace.jsonl}`; verdicts in `e2e-report.json` `tests[]` |
| a device is misbehaving: release and keep it out of the pool | `warden release <leaseId> --bad [reason]` (clear: `warden sim unquarantine <udid>`); claims also probe iOS sims and quarantine hung ones |
| a free port | `warden port claim --json` |
| dev build installed on the device | `warden app ensure ios --udid <udid> --json` (`--variant dev\|e2e`) |
| run the app in a worktree (instead of `expo run:ios`) | `warden dev ios [--udid <udid>] [-- <expo start args>]` — reuses the cached build for the native fingerprint, starts its own Metro on a leased port (refuses another checkout's Metro on it), opens the dev client; `--json` prints `{ udid, port, metroUrl, leaseIds }` |
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

## Driving a device (warden ui)

1. `warden claim ios --json` (or `android`) → pass the returned device on every call (`--udid <udid>`; Android `--serial`), or `export WARDEN_UDID`. Never let a tool pick one. Keep the lease alive: `warden ui` heartbeats it on every call; for a long pause use `warden heartbeat <leaseId>`.
2. Dev client: run `warden dev ios --json` in the background (claims a device and a Metro port, starts a Metro verified to serve this checkout, opens the dev client; first stdout line `{ udid, port, metroUrl, leaseIds }`), then `warden ui open <bundleId> --metro <metroUrl>`. Stop it (Ctrl-C / SIGTERM) to release what it leased.
3. Loop: `warden ui open <bundleId|url>` → `snapshot -i` (lines `@e3 [button] "Sign in" id=sign-in-submit enabled hittable (x,y w×h)`) → act → verify → `close --release`.
   - Act: `press|tap <@eN|selector|x y>`, `longpress`, `fill <target> <text> [--secure]`, `type <text> [--submit]`, `key Enter`, `scroll down [--until <selector>]`, `swipe up`, `alert accept|dismiss|get`, `home`, `back`, `rotate`, `appearance`. Add `--settle` to wait for a quiet screen and print what changed.
   - Verify (not a screenshot): `wait <selector>` · `wait absent <selector>` · `wait text "…"` · `is <selector> visible|enabled|checked|…` (exit 0/1) · `get <selector> text|value|label|count`.
   - Selector: `id=<testID>` (exact) `label=` `text=` `value=` (substring, case-insensitive) `role=` `editable=true` `nth=<i>`; values bare, `"quoted"` or `/regex/`. Prefer `id=`. `@eN` refs die on the next `snapshot`/`find`/`--settle`: exit 4 `stale_ref` → snapshot again. Coordinates only for canvas content.
   - App internals (dev client): `eval <js>`, `tree`, `logs start` then `logs [n]`, `network`, `reload`; exit 3 `devtools_unavailable` on a release build.
   - Keep it: `record start <name>` … `record stop`, `replay .warden-ui/<name>.flow.json`, `export <file> --to e2e/<name>.e2e.ts [--ids e2e/ids.ts]` (resolve each `FIXME`).
4. `--json` on any call gives one `{ok, command, device, generation?, durationMs, result}` or `{ok:false, error:{code, message, hint?}}` document. Exit codes: 0 ok · 1 failed/usage · 2 lease (foreign device: `warden claim` another; none: add `--claim`) · 3 engine/devtools unavailable · 4 stale ref · 130 interrupted. Read the hint before retrying.
5. A view missing from `snapshot`: the app must mark it `accessible` and give it a `testID`; `tree` shows it from the React side. Full reference: docs guide `guides/agent-ui`.
6. For repeatable checks write a spec (row above) instead of replaying by hand.
7. Done: `warden ui close --release` (or `warden release <leaseId>`). Subagents release by lease id or `--mine --label <x>`, never bare `--mine`.
