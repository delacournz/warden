# @delacour/warden-core

What is left of the old core after WSDK-3: golden images, `warden sims`, the affected graph and batch presets. No CLI code (that's `apps/cli`). The rest moved to private sibling packages, each with a curated `exports` map (no `./*`):

| Package | Holds |
|---------|-------|
| `warden-runtime` | `exec` (`Exec`), `git-facts` (`createGitFactsCache`; the host holds the cache, no module-level instance), `node-bin` |
| `warden-store` | `types`, `liveness`, `store` (owns EVERY migration), `builds-table` (typed SQL for builds/installs/fingerprints) |
| `warden-config` | all zod schemas, `define-config`, `duration`, `ports-spec`, `config.defaults`; standalone (`config-boundary.test.ts`) |
| `warden-providers` | `ios`, `android`, `health`, `provider.types`, leaves `golden-name`, `android-tools`, `simctl-list` |
| `warden-leasing` | `allocate`, `claim`, `queue`, `capacity`, `host`, `room`, `ports`, `owner`, `inventory`, `shutdown-policy`, `headless` |
| `warden-builds` | `config`, `project-key`, `fingerprint`, `cache`, `eas`, `local`, `install`, `lock`, `resolve`, `prune`, `ensure` |

Dependency order: runtime, store, config < providers < leasing, builds < core. `scripts/cycles/check-cycles.ts` (part of `bun run check`) fails on package cycles, undeclared workspace deps and top-level-dir cycles inside a package.

## Layout (`src/`)

| Dir | Purpose |
|-----|---------|
| `golden/*.ts` | golden iOS images: `golden` (key, names, staleness plan, parsers, pure), `ios-golden` (build under `golden:ios` lease, clone, prune); `android-golden`: quick-boot snapshot `warden-<key>` per AVD that the Android provider's `snapshot` hook launches claims from; `android-snapshot-pending` marks the AVD; `android-biometrics` enrolls a fingerprint in the build emulator (`+bio` targets) |
| `sims/*.ts` | `warden sims audit\|prune\|delete`: `rules` (pure `judgeSims`), `delete`, `audit`, `prune`, `runtimes`, `slim.measure`, `sims.defaults` (the slim launchd store lives in `warden-providers/slim*`, the profile in `warden-config/slim.profile`) |
| `conditions/*.ts` | device conditions state: `conditions` (record / read per lease, in the store), `undo` (reverse a lease's conditions on release / gc), `orphans` (sweep a dead lease's leftovers), `launch-settings`, `inject-state`; types and presets live in `warden-config` |
| `netproxy/*.ts` | per-lease network proxy (`proxy`, `shaping`, `decide`, `control`, `lease-proxy`, `netproxy.main` child entry) |
| `affected/*.ts` | affected-spec graph (`specs`, `select`), import cache, worker |
| `batch/*.ts` | batch presets, expansion, scheduling, `elastic` (room-aware batch sizing) |
| `host-deps.ts` | `LeaseHost` wiring: provider factory, android snapshot hook / pass, golden deps, conditions undo + orphan callbacks |
| `slim-policy.ts` | `resolveSlim`: flag > config > default slim profile resolution |
| `testing/*.ts` | `golden.testing` (stateful fake simctl host), `fixture.testing`; exported as `./testing/<name>` |

## Rules
- Pure logic takes `now` + `pidAlive` + `exec` as inputs — no hidden clocks/processes in tests.
- Never shut down/erase a device warden didn't create or lease.
- Import files directly (`@delacour/warden-store/store`), no barrels.
- `WARDEN_HOME` overrides `~/.warden` (tests use temp dirs).
- Schema changes: append to `MIGRATIONS` in `warden-store/src/store.ts`; never edit a shipped entry.
- Never run real simctl / adb / eas / xcodebuild in tests — inject `Exec`.
- Goldens (`warden-golden-*`, `InventoryDevice.golden`) are clone sources only: never allocate, adopt, gc or pool-count them. Bump `GOLDEN_RECIPE` when the build steps change.
