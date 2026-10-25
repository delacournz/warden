# @delacour/warden-core

Lease registry + allocation + device providers + build cache. No CLI code here (that's `apps/cli`).

## Layout (`src/`)

| File | Purpose |
|------|---------|
| `types.ts` | `Resource` / `Owner` / `Lease` / `InventoryDevice` / `AllocationPlan` unions, `resourceKey` |
| `store.ts` | bun:sqlite `$WARDEN_HOME/warden.db` (WAL). `transaction()` = `BEGIN IMMEDIATE` = cross-process mutex. `MIGRATIONS` append-only |
| `liveness.ts` | lease alive = heartbeat within ttl OR pid alive; a supervised lease (pid + `heartbeat_ms`, stamped by `holdLeases`) with a dead pid only within `LOST_HEARTBEATS` (3) periods (pure; `processAlive` = kill 0) |
| `allocate.ts` | pure `(inventory, leases, request) → assign{reuse/boot/create} | wait` |
| `owner.ts` | detect owner: hook session → CI → session env → parent pid; git repo/worktree |
| `git-facts.ts` / `headless.ts` / `node-bin.ts` / `shutdown-policy.ts` | `GitFacts` (toplevel / shared git dir / branch via injected `Exec`); `--headless` > config > `WARDEN_HEADLESS` precedence; nearest `node_modules/.bin/<name>`; `shouldShutdown` (only warden-created or owner-booted devices) |
| `inventory.ts` | mark warden-created devices (store record or `warden-<profile>-N` name) |
| `exec.ts` | injectable process runner (`Exec`) |
| `claim.ts` | `claimDevices`: txn(reclaim → allocate → lease, pending placeholders for creates) then boot/create outside txn; all-or-nothing |
| `ports.ts` | `parsePortSpec`, `isPortFree` (bind probe), `claimPorts` (probe outside txn, lease inside), `releasePorts` |
| `duration.ts` / `config.defaults.ts` | `10m`-style durations; TTL 30m, idle 20m, heartbeat 30s, default profiles |
| `affected/*.ts` | `warden affected` / `e2e` selection: `affected.schema` (zod `e2e.<suite>` config incl. `metro`, `devices`, `spec`), `git`, `graph*` (import graph via TS resolver, process / worker / snapshot), `specs`, `select`, `cache` |
| `batch/*.ts` | `warden batch` presets + scheduling: `preset(.schema)`, `expand` (job / command templating), `schedule` |
| `providers/*.ts` | `DeviceProvider` impls (`ios`, `android`) on simctl / adb / emulator, `health` (iOS post-boot probe); Android console ports leased 5554–5584; android `waitReady` applies post-boot Play Protect verifier settings |
| `builds/*.ts` | app build cache: `config` (zod `warden.config.{ts,json}` loader), `define-config` (public documented types + `defineConfig`, published as `@delacour/warden/config`), `project-key`, `fingerprint`, `cache`, `eas`, `local`, `install`, `compiler-cache`, `js-inputs`, `lock` (build lease), `resolve` (5-step resolver), `prune`, `ensure` |
| `sims/*.ts` | `warden sims audit\|prune\|delete`, one path: `list` (the only `simctl list devices -j` parser, `SimctlSim`, du fallback), `rules` (pure `judgeSims`: owner / blockers / reasons / verdict / budget, `canPrune` · `canDelete` · `isSuggested`, `describeReasons`), `delete` (`deleteSims`: lease under txn → shutdown → delete → forget → release), `audit` (totals), `prune` (list + judge + delete), `runtimes` (report-only), `slim` (`warden sim slim` launchd jobs), `sims.defaults` (idle 7d / stale 30d) |
| `golden/*.ts` | golden iOS images: `golden` (key, names, staleness plan, migration/settle parsers, pure), `ios-golden` (build under `golden:ios` lease, clone, prune); `android-golden`: warden's quick-boot snapshot `warden-<key>` per AVD (key from image/emulator/config files and launch flags, writable build under `golden:android:<avd>`, list, prune) that the Android provider's `snapshot` hook launches claims from; claims never build it (`android-snapshot-pending` marks the AVD, `warden gc` / `golden ensure` build) |
| `*.race-fixture.ts` | child-process fixtures for cross-process race tests |

## Rules
- Pure logic takes `now` + `pidAlive` + `exec` as inputs — no hidden clocks/processes in tests.
- Never shut down/erase a device warden didn't create or lease.
- Import files directly (`@delacour/warden-core/store`), no barrels.
- `WARDEN_HOME` overrides `~/.warden` (tests use temp dirs).
- Schema changes: append to `MIGRATIONS` in `store.ts`; never edit a shipped entry.
- Never run real simctl / adb / eas / xcodebuild in tests — inject `Exec` (`golden/golden.testing.ts` = stateful fake simctl host).
- Goldens (`warden-golden-*`, `InventoryDevice.golden`) are clone sources only: never allocate, adopt, gc or pool-count them. Bump `GOLDEN_RECIPE` when the build steps change.
