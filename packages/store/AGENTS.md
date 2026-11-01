# @delacour/warden-store

`types` (Resource/Owner/Lease/InventoryDevice, `resourceKey`, `profileSlug`), `liveness`, `store` (bun:sqlite `$WARDEN_HOME/warden.db`, WAL, `transaction()` = `BEGIN IMMEDIATE`; `MIGRATIONS` append-only and owned here) and `builds-table` (typed SQL for the `builds`/`installs`/`fingerprints` tables; `@delacour/warden-builds` holds no SQL).

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-store/<file>`).
