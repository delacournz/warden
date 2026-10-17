# Assignment 03 · `ios-driver-ts` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/03-ios-driver-ts.md` and `docs/audit/raw/03-ios-driver-ts.jsonl`.

## Improvement goal

Lower per-call overhead in the TypeScript iOS driver (client framing, reply validation, tracing proxy, error mapping), make `app.launch`/relaunch faster, and make client timeouts and respawn robust.

## Owned files

- `packages/e2e/src/driver/ios/*.ts`: `simd-client.ts` (424), `simd-transport.ts` (221), `simd-protocol.ts` (459), `ios-driver.ts` (560), `simctl.ts` (314), `ios-session.ts`, `locate-helper.ts`, `normalize.ts`, `type-budget.ts`, `exec.testing.ts`, `simd.testing.ts` and their tests
- `packages/e2e/src/driver/{open,traced-driver,unwrap,span-detail,refs,settle,typing,alerts,errors,driver.types,driver.testing}.ts` and tests
- `packages/e2e/native/scripts/{smoke.ts,screen-cost.ts}` (what the on-device smoke measures; you cannot run them)

Not yours: the Swift helper (01, 02), `observation-cache.ts` (06), the Android driver (04, 05). `simctl.ts:306-312` AutomationEnabled: read it, but agent 16 owns that finding (cite "see 16").

## Starting hotspots

- **Reply validation**: `docs/plans/wdn-perf.md:50` says "hand-written wire validator (no zod on snapshots)". Check what `simd-client.ts`/`simd-protocol.ts` actually do per `snapshot` reply (459 lines of zod schemas exist). If every snapshot goes through `z.parse`, estimate the cost at 165–173 snapshots per rep and propose the narrow validator; if not, mark the claim confirmed.
- `simd-transport.ts`: NDJSON framing (line splitting, buffer growth, `TextDecoder` per chunk), request id map growth, per-op timeout timers (one `setTimeout` per request?), event fan-out.
- `simd-client.ts`: respawn-once rules, `DEFAULT_READY_TIMEOUT_MS` 15 s, what a timed-out request does to in-flight siblings, socket vs stdio differences, `keepClient` handoff.
- `ios-driver.ts`: `app.launch` = `simctl launch` (`LAUNCH_MS` 30 s, K16) + `rebind` (best effort, remembered failures) + what else; `openUrl`, `terminate`, `install` spawns; `settle` fallback to `settleByHash` when the helper says `E_UNSUPPORTED`; the `launchedBundle` gate; capabilities object construction per call.
- `traced-driver.ts` + `span-detail.ts`: a `Proxy` and an `AsyncLocalStorage` run per driver call; cost per call and whether spans are created outside an attempt.
- `unwrap.ts` / `errors.ts`: any error path that swallows `retryable` or loses `detail`.
- `open.ts`: parallelism of helper connect vs the AutomationEnabled probe; what `openDriver` does when `WARDEN_SIMD_SOCKET` is unset (stdio spawn per spec process).
- `typing.ts`: `pressKeys` path on iOS (one RPC per Backspace), `canRepeatKeys`/`canSelectAll` capability checks.
- `type-budget.ts`: how the request timeout is sized for long texts; failure mode on a slow host.
- `locate-helper.ts`: lookup order cost (stat per rung), `realpath(process.execPath)`.
- Tests: `ios-driver.test.ts` (1186) and `simd-client.test.ts`: anything asserted by wall-clock sleep rather than a fake clock.
