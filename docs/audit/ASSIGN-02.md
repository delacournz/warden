# Assignment 02 · `ios-helper-io` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/02-ios-helper-io.md` and `docs/audit/raw/02-ios-helper-io.jsonl`.

## Improvement goal

Lower per-RPC latency and the helper's RSS/CPU in `warden-simd` (snapshot building and JSON encoding, dispatcher, HID serialisation, screenshot path, idle exit), and establish that the Swift wire, the TS schema and the fake agree op for op and field for field.

## Owned files

- `packages/e2e/native/ios/Sources/warden-simd/Ops/Snapshot.swift` (635: `describe`, `topmostModal`, `alertButtons`, `frontmost`, `readRecovering`, `recoverFromEmptyRoot`)
- `packages/e2e/native/ios/Sources/warden-simd/Model/{Element,ElementBuilder}.swift`
- `packages/e2e/native/ios/Sources/warden-simd/Server/{SocketServer,StdioServer,Dispatcher,Announce}.swift`
- `packages/e2e/native/ios/Sources/warden-simd/Protocol/{NDJSON,Wire}.swift`
- `packages/e2e/native/ios/Sources/warden-simd/{main,Arguments}.swift`
- `packages/e2e/native/ios/Sources/warden-simd/Ops/{Input,Keyboard,Screenshot,Orientation,Health}.swift`
- `packages/e2e/native/ios/Package.swift`
- `packages/e2e/native/ios/Tests/warden-simdTests/**` (codec, keyboard map, role map, document→model fixtures)
- `packages/e2e/native/scripts/fake-simd.ts` and `packages/e2e/native/scripts/element-shape.test.ts`
- Read for the diff only: `packages/e2e/src/driver/ios/simd-protocol.ts` (owned by agent 03)

Not yours: `Ops/Settle.swift`, `Device/Session.swift` (agent 01).

## Starting hotspots

- Snapshot encoding: ~18 KB per read, 165–173 snapshots per 8-test rep (bench). Per-node allocations in `ElementBuilder`, string formatting in `Wire.swift`/`NDJSON.swift`, whether `JSONEncoder` or hand-rolled, whether `interactiveOnly` filtering happens before or after building the full tree, `maxDepth`/`maxNodes` truncation cost.
- `topmostModal` ranking on every snapshot and `alertButtons` with no `backend` = two tree reads; `recoverFromEmptyRoot` re-read.
- Dispatcher: per-connection `ready` event, `selfTimedOps`, how concurrent requests from one client are scheduled (HID serialised; are reads serialised behind HID?), request id handling, timeouts.
- `SocketServer`: accept loop, per-client buffers, the `dup2` of stderr onto fd 1, `IdleTracker` and `--idle-timeout`.
- `Ops/Input.swift` (451): composite HID events, `swipe` easing + 150 ms hold, `durationMs` sleeps; `Ops/Keyboard.swift`: `paceMs` 30 / `holdMs` 40 / `repeatGapMs` 300 are the floor (K9, never lower), but check the request-timeout budget and the per-key `Task.sleep` scheduling overhead.
- `Screenshot.swift`: scale, PNG encode, whether `path` avoids base64 over the wire.
- `Health.swift`: `probe:true` cost; `degraded` bookkeeping.
- **Wire agreement**: build a table op × field of `Wire.swift` vs `simd-protocol.ts` (zod) vs `fake-simd.ts` replies. Any optional field one side sends and the other drops, any error code one side can emit that the other maps to `E_INTERNAL`, any op the fake answers that the Swift side would refuse (or vice versa) is a finding (`contract: wire`).
- Swift tests: what the goldens pin and what they miss (socket mode, idle exit, dispatcher ordering).
