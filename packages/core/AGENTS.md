# @warden/core

Lease registry + allocation + device providers + build cache. No CLI code here (that's `apps/cli`).

## Layout (`src/`)

| File | Purpose |
|------|---------|
| `types.ts` | `Resource` / `Owner` / `Lease` / `InventoryDevice` / `AllocationPlan` unions, `resourceKey` |
| `store.ts` | bun:sqlite `$WARDEN_HOME/warden.db` (WAL). `transaction()` = `BEGIN IMMEDIATE` = cross-process mutex. `MIGRATIONS` append-only |
| `liveness.ts` | lease alive = heartbeat within ttl OR pid alive (pure; `processAlive` = kill 0) |
| `allocate.ts` | pure `(inventory, leases, request) → assign{reuse/boot/create} | wait` |
| `owner.ts` | detect owner: hook session → CI → session env → parent pid; git repo/worktree |
| `inventory.ts` | mark warden-created devices (store record or `warden-<profile>-N` name) |
| `exec.ts` | injectable process runner (`Exec`) |
| `claim.ts` | `claimDevices`: txn(reclaim → allocate → lease, pending placeholders for creates) then boot/create outside txn; all-or-nothing |
| `ports.ts` | `parsePortSpec`, `isPortFree` (bind probe), `claimPorts` (probe outside txn, lease inside), `releasePorts` |
| `duration.ts` / `config.defaults.ts` | `10m`-style durations; TTL 30m, idle 20m, heartbeat 30s, default profiles |
| `providers/*.ts` | `DeviceProvider` impls (`ios`, `android`) on simctl / adb / emulator; Android console ports leased 5554–5584 |
| `builds/*.ts` | app build cache: `config` (zod `warden.config.json`), `project-key`, `fingerprint`, `cache`, `eas`, `local`, `install`, `lock` (build lease), `resolve` (5-step resolver), `prune`, `ensure` |
| `golden/*.ts` | golden iOS images: `golden` (key, names, staleness plan, migration/settle parsers, pure), `ios-golden` (build under `golden:ios` lease, clone, prune) |
| `*.race-fixture.ts` | child-process fixtures for cross-process race tests |

## Rules
- Pure logic takes `now` + `pidAlive` + `exec` as inputs — no hidden clocks/processes in tests.
- Never shut down/erase a device warden didn't create or lease.
- Import files directly (`@warden/core/store`), no barrels.
- `WARDEN_HOME` overrides `~/.warden` (tests use temp dirs).
- Schema changes: append to `MIGRATIONS` in `store.ts`; never edit a shipped entry.
- Never run real simctl / adb / eas / xcodebuild in tests — inject `Exec` (`golden/golden.testing.ts` = stateful fake simctl host).
- Goldens (`warden-golden-*`, `InventoryDevice.golden`) are clone sources only: never allocate, adopt, gc or pool-count them. Bump `GOLDEN_RECIPE` when the build steps change.
