# @delacour/warden-e2e

warden's own mobile e2e stack (plan: `docs/plans/wdn-e2e.md`). No lease / build code here (that's `packages/core`); no CLI code (that's `apps/cli`, which imports from here).

## Layout (`src/`)

| Dir | Purpose |
|---|---|
| `driver/` | `Driver` contract (`driver.types.ts`, **frozen interface** shared by every layer), errors, refs, hash settle, `open.ts`; `ios/` (`warden-simd` NDJSON client + `xcrun simctl` ops), `android/` (persistent `adb shell` + uiautomator), `driver.testing.ts` (FakeDriver) |
| `runner/` | `test`/`describe`/hooks over `bun:test`, attempts, `results.jsonl`, artifacts |
| `screen/` | locator query model, roles, text matching, actions, polling, text render + selector parser (shared with `warden ui`) |
| `expect/` | `expect` wrapper + locator matchers |
| `devtools/` | Metro inspector discovery, Hermes CDP, console/network/React tree |
| `flows/` | `.flow.json` schema, record, replay, export |
| `native/` | `warden-simd` Swift package on idb's library package (`native/ios`), scripts (`deps`, `build`, `smoke`, `fake-simd`) |

## Rules
- Never run real `simctl` / `adb` / `warden-simd` in `bun test` — inject `Exec`, use `driver.testing.ts` / `native/scripts/fake-simd.ts`. Smoke scripts live in `native/scripts` and are run by hand.
- `Result` / `AsyncResult` from `@delacour/warden-types/result`; `DriverResult<T>` = `AsyncResult<T, DriverError>`.
- Import files directly (`@delacour/warden-e2e/driver/open`), no barrels except the published `src/index.ts`.
- Do not change `driver/driver.types.ts` or the `WARDEN_*` names in `env.ts` without updating `docs/plans/wdn-e2e.md` — other agents build on them.
- Tests colocated (`*.test.ts`), TDD, no `any`.
- Flow export goldens live in `src/flows/export.golden/*.e2e.ts` (biome-ignored, typechecked by `tsc`); regenerate with `UPDATE_GOLDEN=1 bun test src/flows/export.test.ts` and review the diff.
