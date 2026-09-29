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
| `providers/*.ts` | `DeviceProvider` impls (`ios`, `android`) on simctl / adb / emulator |

## Rules
- Pure logic takes `now` + `pidAlive` + `exec` as inputs — no hidden clocks/processes in tests.
- Never shut down/erase a device warden didn't create or lease.
- Import files directly (`@warden/core/store`), no barrels.
- `WARDEN_HOME` overrides `~/.warden` (tests use temp dirs).
