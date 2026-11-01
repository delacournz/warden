# @delacour/warden-leasing

`allocate` (pure), `claim`, `queue`, `capacity`, `host`, `room`, `ports`, `owner`, `inventory`, `shutdown-policy`, `headless`. Cross-process races: `ports.race-fixture.ts`.

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-leasing/<file>`).
