# @delacour/warden-e2e

warden's own mobile e2e stack (plan: `docs/plans/wdn-e2e.md`). No lease / build code here (that's `packages/core`); no CLI code (that's `apps/cli`, which imports from here).

## Layout (`src/`)

| Dir | Purpose |
|---|---|
| top level | `index.ts` (the published entry), `env.ts` (`WARDEN_*` names + `readEnv`), `errors.ts`, `session.ts` (process-wide session, `globalThis`), `preload.ts`, `app.ts` / `device.ts` / `device-devtools.ts` / `fixtures.ts` / `fixture-session.ts` (the `app`, `device`, `screen` fixtures) |
| `driver/` | `Driver` contract (`driver.types.ts`, **frozen interface** shared by every layer), errors, refs, hash settle, `typing.ts` (the one text/key pacing path, shared with `warden ui`), `open.ts`; `ios/` (`warden-simd` NDJSON client + `xcrun simctl` ops), `android/` (persistent `adb shell` + uiautomator), `driver.testing.ts` (FakeDriver) |
| `runner/` | `test`/`describe`/hooks over `bun:test`, attempts, `results.jsonl`, artifacts |
| `screen/` | locator query model, roles, text matching, actions, polling, text render + selector parser (shared with `warden ui`), `field.ts` (fill/clear/confirm a text field) |
| `expect/` | `expect` wrapper + locator matchers |
| `devtools/` | Metro inspector discovery, Hermes CDP, console/network/React tree. Metro's inspector proxy 401s a debugger upgrade without an `Origin`: `openCdp` sends `http://127.0.0.1:<port>` (`localhost` is accepted, then the socket is dropped with 1006) |
| `flows/` | `.flow.json` schema, record, replay, export |
| `native/` | `warden-simd` Swift package on idb's library package (`native/ios`), scripts (`deps`, `build`, `smoke`, `fake-simd`) |

## Rules
- Never run real `simctl` / `adb` / `warden-simd` in `bun test` — inject `Exec`, use `driver.testing.ts` / `native/scripts/fake-simd.ts`. Smoke scripts live in `native/scripts` and are run by hand.
- `Result` / `AsyncResult` from `@delacour/warden-types/result`; `DriverResult<T>` = `AsyncResult<T, DriverError>`.
- Import files directly (`@delacour/warden-e2e/driver/open`), no barrels except the published `src/index.ts`.
- Do not change `driver/driver.types.ts` or the `WARDEN_*` names in `env.ts` without updating `docs/plans/wdn-e2e.md` — other agents build on them.
- Tests colocated (`*.test.ts`), TDD, no `any`.
- Flow export goldens live in `src/flows/export.golden/*.e2e.ts` (biome-ignored, typechecked by `tsc`); regenerate with `UPDATE_GOLDEN=1 bun test src/flows/export.test.ts` and review the diff.

## `warden-simd` internals (`native/ios/Sources/warden-simd`)
NDJSON over stdio or a unix socket (`~/.warden/simd/<udid>.sock`, `warden e2e` passes it as `WARDEN_SIMD_SOCKET`). The wire is `src/driver/ios/simd-protocol.ts`; Swift output is pinned by goldens in `Tests/warden-simdTests/Fixtures` (`WARDEN_SIMD_UPDATE_GOLDEN=1 swift test` rewrites them, `native/scripts/element-shape.test.ts` parses them with the zod schemas).
- **AX guests**: `Session.open` builds one `.exclusive` `axbridge` reader (a guest private to this helper, `automationMode: true`) plus a host `ax` reader for per-request fallback. A bridge failure with no explicit `backend` is retried on `ax`, with a `log` warn and `snapshot.fallback.reason`. A bridge answer of one childless area-less root is re-read once, then read on `ax` (`Session.recoverFromEmptyRoot`).
- **Quiescence stream** (`Ops/Settle.swift`, `QuiescenceMonitor`): one stream opened at helper start and kept for its life (the guest follows the frontmost app; ~0.5 s to open). `WARDEN_SIMD_STREAM_IDLE_S=<s>` closes it after that long without a `settle` (default off). Every stream spawns its own guest and two streams on one simulator leave each other stuck: one helper per leased sim.
- **Relaunch repair**: with no stream bound, a relaunched app answers every `axbridge` read with `E_APP_NOT_RESPONDING`. `Session.readRecovering` opens a stream, waits for its first state (max 4 s), reads once more, then falls back to `ax`. First read after a relaunch: ~90 ms with the stream open, ~2 s when repaired.
- **`settle{quietMs=250, settleTimeoutMs|timeoutMs=3000, bundleId?}`** replies `{quiet, waitedMs, via, reason?, frontmostPid?}`. `via` is `stream` (guest reported run-loop idle + animations inactive for `quietMs`) or `snapshot` (stream stuck, two identical reads). `settleTimeoutMs` wins over `timeoutMs`. `bundleId` holds `quiet` back until the stream's frontmost pid is that bundle's process (`FrontmostGate`); at the deadline `quiet:false, reason:"frontmost_mismatch"`. A deadline is not an error. Needs `axbridge` (`E_UNSUPPORTED` otherwise; the TS side then polls hashes).
- **Key pacing** (`Ops/Keyboard.swift`): `key` / `typeText` take `paceMs` (quiet after each key, default 30), `holdMs` (down to up, 40), `repeatGapMs` (extra before a repeated key, 300), each 0..1000. `WARDEN_SIMD_PACE_MS` / `WARDEN_SIMD_HOLD_MS` / `WARDEN_SIMD_REPEAT_GAP_MS` change the defaults. A React Native field digests ~45-50 ms per key; faster loses characters. `driver/ios/type-budget.ts` sizes the request timeout.
- **`health`**: `ax.bridge` is `available | missing | failed | degraded`. `degraded` + `ax.lastError {message, agoMs}` means the guest is present but the last read failed (the next good read clears it). `health{probe:true}` (what `--health` runs) reads through the bridge and reports `failed`. A fresh `--health` process has no read history, so `warden doctor` also asks the running helper's socket.
- **Tracing**: `--trace` or `WARDEN_SIMD_TRACE=1` logs one debug event per quiescence sample; `--verbose` logs more; the log file is `~/.warden/simd/<udid>.log`.
- **AutomationEnabled**: the bridge needs `com.apple.Accessibility` `AutomationEnabled`. `ios-driver.ts` reads the sim's plist with `plutil` (~10 ms) and only runs `simctl spawn defaults write` (300-500 ms) when it is not already true.
- **Non-public API** (breaks first on a new Xcode): `Simulator.defaultHIDTransport` (mirrored in `Session.negotiatedTransport`: DTUHID from CoreSimulator 1155.4, else Indigo), `SimulatorDeviceOrientation.hidOrientation` (mirrored in `Session.hidOrientation`), the CoreDevice orientation service (a failed read falls back to `OrientationMemory`, `source` `written` / `assumed`), plus idb's private CoreSimulator and Accessibility use.
- **After an Xcode update**: `bun run --cwd packages/e2e native:build`, `swift test --package-path packages/e2e/native/ios`, `dist/warden-simd --health --udid <udid>` (expect `ax.bridge=available` and the right `hid.transport`), then `bun native/scripts/smoke.ts --udid <udid>` on a leased sim with the example app (`--kill-bridge` / `--kill-helper` exercise recovery). `warden doctor` shows the idb and Xcode versions the helper was built with.
