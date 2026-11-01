# @delacour/warden-providers

`DeviceProvider` impls (`ios` on simctl, `android` on adb/emulator), `health`, and the leaves `golden-name`, `android-tools`, `simctl-list`. Depends on runtime/store/config only (never leasing).

## Rules
- `exports` is a curated map (no `./*`). Test helpers live in `src/testing/` and are exported as `./testing/<name>`.
- Race-fixture scripts (`*.race-fixture.ts`) are spawned by path, never imported.
- Package graph is acyclic: `bun run check` runs `scripts/cycles/check-cycles.ts`.
- No barrels; import files directly (`@delacour/warden-providers/<file>`).
