# @delacour/warden-runtime

Injectable process runner (`exec`), the git-facts cache (`createGitFactsCache`, held by the caller/host, no module-level state) and `node-bin`.

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-runtime/<file>`).
