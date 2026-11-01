# @delacour/warden-builds

App build cache: `config` (warden.config loader), `project-key`, `fingerprint`, `cache` (files), `eas`, `local`, `install`, `lock`, `resolve`, `prune`, `ensure`. Table access goes through `@delacour/warden-store/builds-table`.

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-builds/<file>`).
