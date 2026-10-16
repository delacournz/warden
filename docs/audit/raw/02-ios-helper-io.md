# 02 · ios-helper-io (warden-simd I/O, dispatcher, snapshot render, HID, wire agreement)

Scope: `warden-simd` server/protocol/model/ops files listed in `ASSIGN-02.md`, `fake-simd.ts`, `element-shape.test.ts`; `simd-protocol.ts` read for the wire diff only. Commit `dfcc68b` (HEAD `d6629f7` differs only in `docs/`).

Headline: nothing in my files costs ≥ 1 s per test. The Swift side of a snapshot (build + modal + JSON encode of a 48-node / 18.9 KB tree) is estimated at a few ms against a 76 ms average snapshot span (13.0 s / 170 per rep, `docs/bench/ios-2026-10-16-perf.md:141`), and the wire is not where the time goes. What I did find is robustness in the server loop (blocking writes on the cooperative pool, in-flight ops that outlive their client and pin idle exit), a missing timing split that blocks attributing the 13.0 s snapshot bucket, and a wire agreement that is pinned for element payloads only.

## Top 5 by impact

- 02-2 In-flight ops outlive their client and the shutdown: a hung self-timed op (`settle`/`rebind`) pins `IdleTracker`, so a resident helper never idle-exits; `withTimeout` ignores parent cancellation.
- 02-3 The 13.0 s/rep snapshot bucket cannot be split: the helper's `ms` excludes encode/write, the TS driver drops `readMs`/`ms`/`nodes`, and `log` events never reach socket clients.
- 02-1 Response writes are blocking `write(2)` calls on Swift's cooperative pool with no send timeout and an 8 KB default unix-socket send buffer.
- 02-6 Wire agreement is pinned for element payloads only; `fake-simd.ts` drifts from the Swift server in five places.
- 02-4 An encode failure answers with `id: null`, which the TS client discards, so the caller waits out its full timeout.

## Findings

### 02-1 Response writes block cooperative-pool threads with no send timeout

- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `OutputChannel.fileDescriptor` loops on a blocking `write(fd, …)` until every byte is out, retrying only `EINTR` (`packages/e2e/native/ios/Sources/warden-simd/Server/StdioServer.swift:15-29@dfcc68b`). `send` holds the channel's `NSLock` across that write (`StdioServer.swift:31-36@dfcc68b`).
  - `send` is called from the op task (`StdioServer.swift:135@dfcc68b`). That task is a child of the connection's `withTaskGroup` (`StdioServer.swift:110-120@dfcc68b`), so it runs on the Swift concurrency cooperative pool, which has one thread per core. `OpLog` writes the same way from inside the `QuiescenceMonitor` actor when tracing (`Ops/Settle.swift:265-268@dfcc68b` → `Ops/Snapshot.swift:31-37@dfcc68b`).
  - Accepted client sockets only get `SO_NOSIGPIPE` (`Server/SocketServer.swift:283-284@dfcc68b`): no `SO_SNDTIMEO`, no `O_NONBLOCK`, no larger `SO_SNDBUF`. The macOS default unix-stream send space is 8192 bytes (`sysctl net.local.stream.sendspace`), while a snapshot is 18.9 KB (`Tests/warden-simdTests/Fixtures/sign-in.snapshot.golden.json`, compact). So every snapshot write blocks until the reader has drained at least two buffers.
  - A client that is alive but not reading (bun stopped at a debugger breakpoint, a `warden ui` process suspended with ^Z, a JS event loop stalled by synchronous work) holds one pool thread per pending response for as long as it is not reading. Every later `send` on that connection queues on the lock, each holding a pool thread too. With enough of them (14 on the bench M4 Pro) every async job in the helper stalls, including the shared quiescence stream and other clients.
- Impact: estimated. No cost in the normal case. The failure needs a stalled reader, but then it is unbounded, it spreads beyond the one connection once N ≥ cores, and nothing in the helper ever recovers it. Platform: ios (host).
- Proposed fix: give each connection a dedicated writer (a serial `DispatchQueue`, or a `Thread` like the reader) so blocking I/O never runs on the cooperative pool. Set `SO_SNDBUF` to about 256 KB so a snapshot goes out in one write, and `SO_SNDTIMEO` to about 5 s; on `EAGAIN`/timeout, `shutdown(fd)` the connection and close the channel. Files: `Server/StdioServer.swift`, `Server/SocketServer.swift`. Contract: additive.
- Effort: S
- Risk: low. Ordering within a connection must stay per-line atomic (a serial queue keeps it). Needs macOS for `swift test`, not a simulator.
- How to verify: new `SocketServerTests` case: connect, send 20 `snapshot`-sized echo requests, never read; assert that a second client's `health` still answers within 1 s, and that the stalled connection is dropped after the send timeout.
- Confidence: med (the mechanism is certain; the trigger is rare)
- Verified by: read; traced path from `StdioServer.serve` → `OutputChannel.send` → `write(2)`

### 02-2 In-flight ops outlive their client and the shutdown; a hung self-timed op pins idle exit forever

- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `settle` and `rebind` are exempt from the envelope `timeoutMs` and get no other backstop (`Server/Dispatcher.swift:17,35-42@dfcc68b`; pinned by `SocketServerTests.swift:351-361`). Their budgets are enforced inside `Ops/Settle.swift` (agent 01), but awaits there sit outside the deadline loop: `reapWedgedGuests()` after the verdict (`Settle.swift:861@dfcc68b`), `RebindPrelude.run` (ps, kill, stream restart that awaits the old task "which may still be inside its open call") before the budget is computed (`Settle.swift:888-892@dfcc68b`), and the launchd lookup `resolveBundlePid`. If one of them never returns, the op never answers.
  - When a client disconnects, the `for await` ends but `withTaskGroup` waits for every child (`StdioServer.swift:110-120@dfcc68b`). Nothing cancels them. `tracker.connectionClosed()` runs only after `server.run` returns (`SocketServer.swift:304-306@dfcc68b`), and `opFinished` only after the handler returns (`StdioServer.swift:133-136@dfcc68b`).
  - `IdleTracker.isExpired` needs `clients == 0 && inflight.isEmpty` (`SocketServer.swift:139-144@dfcc68b`), so one leaked key (`"c7:42"`) keeps a resident helper alive for good. A helper resident after release relies on idle exit as its only reaper apart from an explicit `release --shutdown` / `ui close` (packages/e2e AGENTS "Resident after release"). A lingering helper keeps its quiescence stream open, which stalls any other stream on that sim (settle `via:"snapshot"`, ~2.5 s instead of ~260 ms, same doc).
  - `withTimeout` is not cancellation-aware: `work` and `timer` are unstructured `Task`s and the continuation has no cancellation handler (`Dispatcher.swift:52-76@dfcc68b`). So when stdio-mode `shutdown` cancels the loop (`StdioServer.swift:122,137-139@dfcc68b`), each in-flight op still runs until its own `timeoutMs` (10 s default, `simd-client.ts:71`). The TS side waits 1.5 s and then SIGTERMs (`simd-transport.ts:79,119-134@dfcc68b`). A cancelled op that does finish is reported as `E_INTERNAL "operation cancelled"`, not retryable (`Device/Session.swift:208@dfcc68b`).
- Impact: estimated. Normal runs: none. When a self-timed op hangs (idb/CoreSimulator stalls, a wedged guest K7): the helper never idle-exits (default 600 s, `Arguments.swift:42`) and keeps degrading other tools' settles by ~2.2 s each until someone runs `ui close`. Stdio driver close with an op in flight costs ≤ 1.5 s plus a SIGTERM. Platform: ios.
- Proposed fix: (1) In socket mode, call `group.cancelAll()` once the input ends: the peer is gone and its responses cannot be delivered. (2) `IdleTracker.connectionClosed(id:)` drops every in-flight key with that connection's `"cN:"` prefix, and `SocketServer.serve` calls it when the reader exits rather than after `server.run`. (3) Self-timed ops get a backstop of the envelope `timeoutMs` + 2 s (the TS client already pads its timer by `SETTLE_MARGIN_MS`). (4) `withTimeout` wraps the continuation in `withTaskCancellationHandler` and cancels `work` and `timer`. Files: `Server/Dispatcher.swift`, `Server/StdioServer.swift`, `Server/SocketServer.swift`. Contract: additive (the wire is unchanged; a late self-timed answer becomes `E_TIMEOUT`, which TS already maps to `reason:"helper_timeout"`, `ios-driver.ts:310`).
- Effort: M
- Risk: med. Cancelling `settle` mid-restart must leave exactly one stream (the `QuiescenceMonitor.restart` invariant, agent 01). Verifiable with `swift test`; one on-device run of `smoke.ts --kill-helper` afterwards.
- How to verify: `SocketServerTests`: (a) a `settle` handler that never returns, client disconnects, `IdleTracker(timeout: 0.15)`: assert `run()` returns `.idle`. (b) `DispatcherTests`: cancelling the caller of `handle` with a 30 s `timeoutMs` returns within 100 ms. On device: `warden ui close` should never be needed after `pkill -STOP` of the bun test process, then `-KILL`.
- Confidence: med (the leak mechanism is certain; whether those Settle-side awaits can hang needs a device)
- Verified by: read; traced path from `SocketServer.serve` → `StdioServer.run` → `Dispatcher.handle` → `Session.settle/rebind`

### 02-3 The snapshot bucket (13.0 s/rep) cannot be split between AX read, helper render/encode and transport

- Category: dx
- Severity: P2
- Known?: known-extended K1
- Evidence:
  - The helper reports `readMs` (the AX read, including empty-root recovery) and `ms` (`Ops/Snapshot.swift:276,288-290@dfcc68b`). `ms` is taken before `NDJSON.encodeLine` and before the write (`StdioServer.swift:32-35@dfcc68b`), so encode and transport are in no helper number.
  - The TS driver drops all three: `fetchSnapshot` reads only `fallback` (`packages/e2e/src/driver/ios/ios-driver.ts:198-207@dfcc68b`), and nothing calls `noteSpanDetail` with them. So the `driver.snapshot` span is one undivided number.
  - Bench: 170 snapshots took 13.0 s per rep (`docs/bench/ios-2026-10-16-perf.md:141`), or 76 ms each, against "reads cost 6 to 40 ms" (`packages/e2e/AGENTS.md`, device.alert). About 35-70 ms per snapshot is unattributed.
  - Also in socket mode (the default under `warden e2e`), helper `log` events never reach the client: `OpLog` is bound to the process-level channel (`main.swift:32-33@dfcc68b`), which is `dup2`ed onto the log file after the announce (`main.swift:90-91`, `Server/Announce.swift:30-34@dfcc68b`). Per-connection channels (`SocketServer.swift:296`) carry only responses and `ready`. `OpLog` never sets `id` (`Snapshot.swift:31-37`), so a warn such as "axbridge returned an empty tree" cannot be tied to a span even in stdio mode.
- Impact: estimated, indirect. It unblocks the largest per-rep bucket the helper touches (13.0 s of the 58.5 s idiomatic iOS suite). Without the split, any optimisation of `ElementBuilder` or the encoder (my estimate: 0.3-2 ms of the 76 ms) or of the TS normaliser is a guess. Platform: ios.
- Proposed fix: helper: add `renderMs` (build + modal) next to `readMs`, and an `encodeMs` debug log behind `--trace`. Route `OpLog` lines with the op's request id through the requesting connection's channel (a task-local channel set in `StdioServer.serve`). TS (agent 03): `noteSpanDetail("helperMs", data.ms)`, `readMs`, `nodes`, so `trace.jsonl` spans carry them and the bench can compute transport + TS parse as span ms − helper ms. Files: `Ops/Snapshot.swift`, `Server/StdioServer.swift`, `src/driver/ios/ios-driver.ts`. Contract: additive (`snapshotDataSchema` is a `looseObject`).
- Effort: S
- Risk: low
- How to verify: `bun test src/driver/ios/ios-driver.test.ts` with a span-detail assertion. Then one bench rep: `bun run bench run --platform ios --frameworks warden --runs 1` and sum `readMs` against span ms per test.
- Confidence: high
- Verified by: read; traced path from `Session.snapshot` → `OutputChannel.send` → `fetchSnapshot`

### 02-4 An encode failure answers with `id: null`, which the TS client discards

- Category: robustness
- Severity: P3
- Known?: new
- Evidence: `NDJSON.encodeLine` gets the whole response. If `JSONEncoder` throws (non-finite double; the default strategy throws), it replaces the line with `Response.failure(id: nil, …)` (`Protocol/NDJSON.swift:18-29@dfcc68b`), so the request id is lost. The TS `responseSchema` requires `id: z.string()` (`src/driver/ios/simd-protocol.ts:207-210@dfcc68b`). `handleLine` logs and drops the line (`simd-client.ts:192-198@dfcc68b`), and the request waits for its full client timer (10 s default). `E_TIMEOUT` is retryable, so a snapshot poll repeats the same failure until the locator timeout. Frames are sanitised (`ElementTests.testNonFiniteFrameEdgesBecomeZero`), but `tapPoint` from `.actionable(point)` is not (`Model/ElementBuilder.swift:59-61@dfcc68b`) and is only requested with `reachability:true` (`elementAtPoint`). The same `id: null` shape is the helper's answer to any unparseable request (`Protocol/Wire.swift:176-178`, pinned by `NDJSONTests.testFailureWithoutIdEncodesNull`): the two sides disagree on it.
- Impact: estimated. Rare; when hit, ≤ 10 s per call instead of an immediate `E_INTERNAL`. Platform: ios.
- Proposed fix: encode `data` separately in `OutputChannel.send(_ response:)` and on failure send `Response.failure(id: originalId, E_INTERNAL)`. Clamp `tapPoint` like frames. Have TS accept `id: null` failures and log them as `warn`. Files: `Protocol/NDJSON.swift`, `Server/StdioServer.swift`, `Model/ElementBuilder.swift`, `simd-protocol.ts` (03). Contract: wire (TS accepts a nullable id).
- Effort: S
- Risk: low
- How to verify: `NDJSONTests`: encode a success response carrying `.double(.nan)` and assert the line is a failure with the original id.
- Confidence: med
- Verified by: read

### 02-5 Empty-root recovery ignores `snapshot{pid}` and is invisible in the reply

- Category: correctness
- Severity: P3
- Known?: new
- Evidence: `snapshot` queries `.application(pid:)` when `pid` is given (`Ops/Snapshot.swift:268@dfcc68b`), but `recoverEmptyRoot` re-reads `.frontmost` on both readers (`Snapshot.swift:332,335@dfcc68b`). So a `pid` read (SpringBoard, for system prompts) that returns an empty root is answered with the frontmost app's tree, labelled as the requested read. The recovery costs `retryDelay` 150 ms plus one or two reads (`Snapshot.swift:314-323,344@dfcc68b`). It leaves only a `warn` (in the log file in socket mode, see 02-3), and the reply sets `fallback` only when it fell through to `ax`. A bridge re-read that succeeded looks like an ordinary slow read.
- Impact: estimated. A debug-path correctness bug; the timing blind spot is ≥ 150 ms per occurrence, frequency unknown (count `axbridge returned an empty tree` in `~/.warden/simd/<udid>.log` after a bench run). Platform: ios.
- Proposed fix: thread the request's `query` into `recoverEmptyRoot`. Add `recovered: "emptyRoot"` to the reply (looseObject on the TS side). File: `Ops/Snapshot.swift`. Contract: additive.
- Effort: S
- Risk: low
- How to verify: `EmptyRootTests`: assert that the bridge re-read closure receives the pid query. On device, `grep -c "empty tree" ~/.warden/simd/<udid>.log` after a bench rep.
- Confidence: high
- Verified by: read

### 02-6 Wire agreement is pinned for element payloads only; `fake-simd.ts` drifts from the Swift server

- Category: test-gap
- Severity: P3
- Known?: new
- Evidence: `element-shape.test.ts` parses three snapshot goldens, two alert goldens and one hit capture (`native/scripts/element-shape.test.ts:37-41,119-160@dfcc68b`; passes, ran 20/20). `health`, `ready`, `settle`, `rebind`, `frontmost`, `orientation`, `screenshot` and error envelopes have zod schemas (`simd-protocol.ts:179-187,239-360`) but no Swift-produced golden. `expectNoStrippedKeys` on `snapshotDataSchema` (a `looseObject`) can never fail at the top level. Op × field diff (Swift → zod → fake):

  | Op | Swift sends | zod | fake-simd / simd.testing |
  |---|---|---|---|
  | `shutdown` | `{bye:true}` (`Ops/Health.swift:9-11`) | not validated | `data: null` (`fake-simd.ts:135-137`, `simd.testing.ts:98-100`) |
  | parse failure | response `{id:null\|id, ok:false, E_BAD_REQUEST}` (`StdioServer.swift:129-130`) | `id` must be a string, so a null id is dropped | a `log` warn event, no response (`fake-simd.ts:151-153`) |
  | envelope `timeoutMs` | races non-self-timed ops, answers `E_TIMEOUT` retryable (`Dispatcher.swift:35-39`) | — | ignored; never emits `E_TIMEOUT` and has no self-timed distinction (`fake-simd.ts:121-144`) |
  | `--idle-timeout` | exits after N s idle (`SocketServer.swift:246-257`) | — | ignored (`fake-simd.ts:10`), so `apps/cli` helper tests cannot exercise idle exit |
  | socket `shutdown` | answers, then `stop()` | — | `conn.write` then `process.exit(0)` at once (`fake-simd.ts:136-137,71-80`), so the ack can be lost |
  | `tap`/`key`/… | `{}`; `typeText` `{typed:n}` (`Input.swift:268,387`) | not validated | `null` |
  | `health.coreSimulatorVersion` | string or `null` (`Health.swift:86`) | looseObject passes it | n/a |
  | error codes | 13 codes (`Wire.swift:113-127`) | every one is a `DRIVER_CODES` member or mapped (`E_UNKNOWN_UDID`) (`simd-protocol.ts:395-429`) | scripted |

  The other ops (`snapshot`, `elementAtPoint`, `alertButtons`, `frontmost`, `orientation`, `screenshot`, `settle`, `rebind`) agree field for field. No op is answered by one side and refused by the other.
- Impact: estimated. No current runtime bug. The drift keeps TS tests green against behaviour the real helper does not have (the helper-side `E_TIMEOUT`, the parse-failure response, idle exit). Platform: ios.
- Proposed fix: have Swift tests write goldens for `health`, `ready`, `settle`, `rebind`, `frontmost`, `orientation`, the error envelope and parse-failure lines, and extend `element-shape.test.ts` to parse them. Make fake-simd honour `timeoutMs` (answer `E_TIMEOUT` unless the op is `settle`/`rebind`), answer parse failures like Swift, reply `{bye:true}`, flush before exit (`conn.end()` + `setTimeout(exit)`), and implement `--idle-timeout`. Files: `Tests/warden-simdTests/*`, `native/scripts/fake-simd.ts`, `native/scripts/element-shape.test.ts`, `src/driver/ios/simd.testing.ts` (03). Contract: additive.
- Effort: M
- Risk: low; `swift test` needs macOS
- How to verify: `bun test native/scripts/element-shape.test.ts`; `bun test apps/cli/src/agent-ui/helper.integration.test.ts` with an idle-timeout case.
- Confidence: high
- Verified by: ran `bun test native/scripts/element-shape.test.ts` (20 pass); read

### 02-7 Key-pacing env overrides are invisible to the TS `typeText` budget

- Category: robustness
- Severity: P3
- Known?: known-extended K9
- Evidence: the helper's defaults come from `WARDEN_SIMD_PACE_MS` / `HOLD_MS` / `REPEAT_GAP_MS` (`Ops/Keyboard.swift:81-98@dfcc68b`). The defaults 30 / 40 / 300 are the floor and are confirmed unchanged. The TS budget hard-codes 70 ms per character and 300 ms per repeat on a 10 s base (`src/driver/ios/type-budget.ts:2-14@dfcc68b`), and `ready` does not carry the pacing (`Health.swift:35-45`). With overrides of, say, pace 100 / hold 100, a 100-character string needs 20 s against a 17 s budget: the client gets `E_TIMEOUT` while the composite keeps typing, holding the HID gate (`Input.swift:139-180`), so the next tap queues behind the typing. The measured 60-76 ms per character (`wdn-perf.md:172`) against 70 ms budgeted leaves 6 ms per character of overrun to the 10 s base: at most about 1,600 characters at the defaults.
- Impact: estimated. Only with overrides or very long strings. Platform: ios.
- Proposed fix: add `keys: {paceMs, holdMs, repeatGapMs}` to the identity fields and have `typeTextBudgetMs` use them. Files: `Ops/Health.swift`, `type-budget.ts` / `ios-driver.ts` (03). Contract: additive.
- Effort: S
- Risk: low
- How to verify: `type-budget.test.ts` with injected pacing; `AnnounceTests` asserting the field.
- Confidence: high
- Verified by: read

## Known items

- K1 known-extended (02-3): the 76 ms/snapshot against 6-40 ms read gap is the attributable part of the iOS bucket; the helper and the driver need to export `readMs` and `ms`.
- K9 known-extended (02-7): defaults 30 / 40 / 300 confirmed at `Keyboard.swift:90-98`; per-key scheduling is idb composite `.delay` events, and the measured 60-76 ms per character shows little overhead. Do not lower them; the gap is the budget versus the env overrides.
- K11 known-confirmed: the cold start is serial in `main.swift:39-93`. `Session.open` (CoreSimulator, HID, AX readers) has to finish before the socket listens and the ready line is printed; `warmQuiescence` then opens a stream guest in the background, in parallel with the first read's guest. Listening earlier would save only the connect and handshake overlap (estimated < 30 ms), so it is not a finding; the cost is inside `Session.open` (agent 01).
- K12 / K2: the helper's share of host CPU and RSS is unmeasured (see Gaps). In my files the idle helper wakes about 15 times a second (`SocketServer.swift:249` 100 ms idle poll, `SocketServer.swift:279` 200 ms accept poll), which is negligible CPU.

## Gaps I could not assess here

- Swift-side cost per snapshot. My estimate is 0.3-2 ms for `ElementBuilder.build` + `topmostModal` (recursive `preorder` copies, about 48 × depth 23, `Element.swift:111-113`) + `JSONEncoder` over the `JSON` enum with `.sortedKeys` (`NDJSON.swift:11-15`, about 1,000 values / 18.9 KB). That is below the P2 threshold (≤ 0.34 s/rep), so it is not a finding. Measure it on the device with 02-3's `renderMs`, or with `log stream`/Instruments time profiling of `warden-simd` during `bun native/scripts/smoke.ts --udid <udid>`. Rewrite only if `ms - readMs` + encode exceeds 5 ms.
- Helper RSS and CPU during the bench (K2/K12): sample `ps -o rss=,%cpu= -p $(pgrep -f 'warden-simd --udid')` every 500 ms alongside `bun run bench run --platform ios --frameworks warden --runs 1`.
- Whether `drain: .perEvent` (`Input.swift:417`) adds latency per tap: time `tap` spans (62 per rep) on the device, with idb's `.perEvent` against a composite flush.
- Whether idb's `describe`, the quiescence open and `processID(forBundleID:)` can hang (the 02-2 trigger): on the device, `kill -STOP` the AX guest (`SimulatorFrameworkBridge-iOS serve`) during a `settle` and check that `health` and idle exit still work.
- `health{probe:true}` reads with the default `AccessibilityRequestOptions()` (`Health.swift:77`), the heavier key set that `wireKeys` avoids. Its cost is only paid by `--health`/doctor; I could not time it here.

## Owned files not read

- `packages/e2e/native/ios/Tests/warden-simdTests/*.swift`: I listed every test name and read `ElementTests` (non-finite frames), `NDJSONTests` (encode), `DispatcherTests` (timeout), `SocketServerTests` (idle, self-timed) and `InputTests` (HID overlap) in part. I did not read the bodies of `AlertBackendTests`, `AnnounceTests`, `ArgumentsTests`, `EmptyRootTests`, `ErrorMappingTests`, `KeyboardTests`, `SnapshotFixtureTests` and `DocumentFixture.swift` line by line.
- Fixture `*.document.json` files: I checked sizes and the goldens' shape (node counts, depth, bytes); I did not read their contents.

## Questions for the user

- Is stdio mode (no `WARDEN_SIMD_SOCKET`) still a supported production path, or only a test path? If only tests, the stdio shutdown part of 02-2 drops to cosmetic.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-02.md`, `docs/bench/ios-2026-10-16-perf.md`, `docs/plans/wdn-perf.md` (grep), `packages/e2e/AGENTS.md`/`CLAUDE.md`
- `packages/e2e/native/ios/Package.swift`
- `Sources/warden-simd/{main,Arguments}.swift`, `Server/{SocketServer,StdioServer,Dispatcher,Announce}.swift`, `Protocol/{NDJSON,Wire}.swift`, `Model/{Element,ElementBuilder}.swift`, `Ops/{Snapshot,Input,Keyboard,Screenshot,Orientation,Health}.swift`
- Partially, for mechanism: `Device/Session.swift` (status, screen, error mapping), `Ops/Settle.swift` (settle/rebind entry, stream start)
- `native/scripts/fake-simd.ts`, `native/scripts/element-shape.test.ts`
- For the diff: `src/driver/ios/simd-protocol.ts`, plus parts of `simd-client.ts`, `simd-transport.ts`, `ios-driver.ts`, `type-budget.ts`, `simd.testing.ts`, `driver/errors.ts`, `apps/cli/src/agent-ui/helper.ts` (spawn line)
