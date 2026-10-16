# Assignment 04 · `android-uiad` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/04-android-uiad.md` and `docs/audit/raw/04-android-uiad.jsonl`.

## Improvement goal

Lower the device-side CPU and RSS of the resident `warden-uiad` server (~143 MB RSS measured), bring the snapshot traverse p95 down (K6: ~270 ms right after navigation), make the event-based settle sounder, and establish Java↔TS wire agreement plus sound single-flight / give-up rules on the TS side of the server.

## Owned files

- `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/{Main,Uia,Json}.java` (936 lines)
- `packages/e2e/native/android/scripts/{build,record,smoke}.ts` and `build.test.ts`
- `packages/e2e/src/driver/android/{uiad-protocol,uiad-client,uiad-backend,uiad-device,uiad-ops,uiad.testing}.ts` and their tests, `fixtures/uiad-session*.ndjson`
- Read-only context: `packages/e2e/AGENTS.md` § Android driver internals, `docs/plans/wdn-perf.md` § Android server (PERF-3.2 spike, wire protocol, hidden-API drift, fallbacks, PERF-3.3 status)

Not yours: `android-driver.ts`, `adb-session.ts`, dump path (agent 05). `uiad-dex.generated.ts` is generated: do not read it beyond its header.

## Starting hotspots

- `Uia.java` traverse: recursion per `AccessibilityNodeInfo`, `getBoundsInScreen`, `isVisibleToUser` pruning, `recycle()` of nodes (leak = RSS growth), `clearCache()` on every `fresh:true` snapshot (cost vs staleness), `rootWaitMs` 500, `maxNodes` 5000, `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` toggled per `scope:"all"` request (what does toggling service flags cost?).
- `Json.java`: `StringBuilder` growth per node, `\uXXXX` escaping of every non-ASCII char, number formatting; per-snapshot allocations at 150–190 nodes.
- `Main.java`: single-threaded op loop; the main `Looper`; stdin reading (buffered?); `System.out` redirection; what happens on a slow reader (backpressure); process exit paths; `settle` implementation (event listener, `quietMs`, significant-event filter) and the 80 ms quiet after `typeText`/`key`.
- Reflection: are `Method` handles cached once or looked up per call (`injectInputEvent` 3-arg/2-arg, `UiAutomation.connect`)?
- `typeText` via `ACTION_SET_TEXT` + `ACTION_SET_SELECTION`: correctness with the caret, password fields, read-back.
- `uiad-client.ts`: ready handshake 5 s, request ids, per-op timeouts, "a timed-out request kills the server" (cost of a restart ~100 ms vs the lost in-flight op), stderr → `log` events.
- `uiad-backend.ts`: lazy single-flight start, give-up rules (2 failed starts in a row, > 4 starts), `uiadUnsupported` persisted per build id; can a transient failure permanently disable the server for a lease?
- `uiad-device.ts`: dex path by hash, write through `adb shell cat` on every run (is `test -f` checked first? measured 29–67 ms), `ps -A -o PID,ARGS` holder lookup, busy rule (kill only `warden-uiad` by pid, retry once, 2 s re-ask).
- `uiad-ops.ts`: which failures fall back to `input`/dump and which surface; is any fallback double-executing a non-idempotent op?
- **Wire agreement**: table op × field of `Main.java`/`Json.java` output vs `uiad-protocol.ts` (`readNode`/`readSnapshotData` hand-written on the hot path, zod elsewhere) vs the recorded `uiad-session.ndjson` the fake replays. Fields one side emits and the other drops, codes mapped to `E_INTERNAL`, ops the fake answers that the server does not: findings (`contract: wire`).
- **Test gap**: the Java has no unit tests of its own (only the TS fixtures and `build.test.ts`). Report what a device-free Java test harness could cover.
