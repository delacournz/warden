# @delacour/warden-config

ALL zod schemas + `define-config` (published as `@delacour/warden/config`) plus the pure leaves they need: `duration`, `ports-spec`, `config.defaults`. Imports only zod, warden-types, node and itself (enforced by `config-boundary.test.ts`).

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-config/<file>`).
