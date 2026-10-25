# CPU profile of `warden-simd` during a warm rep (iOS, 2026-10-25)

What the helper spends its CPU on, measured on a developer Mac under load (load average 16 on 14 cores), so only the *distribution* counts here; the per-rep totals come from the EAS workers (run `01a172f5`, 2026-10-25: `warden-simd` 7.03 CPU-s per rep = 77 % of warden's host CPU).

## Setup

| | |
|---|---|
| Run | `bun run bench run --platform ios --frameworks warden --runs 3 --udid <leased> --force --skip-doctor --out .bench/cpu-prof-2026-10-25` on a `warden claim ios --headless` simulator (`warden-iphone-17-5`, iPhone 17, iOS 26.5), the pinned bench app, commit `70717676` |
| Result | 3 reps, 100 % pass, warm suite median 63.64 s, host 7.82 CPU-s per rep: `warden-simd` 6.25 s (80.3 %), `bun` exit charge 0.67 s, `bun test` 0.49 s, `simctl` 0.27 s |
| Profilers | `xctrace record --template 'Time Profiler' --attach <warden-simd pid> --time-limit 60s` during rep 2 (on-CPU samples only, 1 ms, the authoritative view); `sample <pid> 45 1` of the helper during rep 2 and 30 s during rep 3 (wall-clock, every thread, used for thread inventory and symbolication); `sample` of `bun test`, `backboardd` and a 30 s idle helper |
| Symbolication | The shipped `dist/warden-simd` is stripped; addresses were resolved with `atos` against `packages/e2e/native/ios/.build/release/warden-simd` at the recorded load address |
| Per-rep op counts | From `artifacts/warden/rep-2/warden-out/*/*/trace.jsonl` |

## Where the helper's CPU goes

Time Profiler, 60 s window inside rep 2: **5.87 s on CPU** (9.8 % of one core), spread over 7 cooperative-pool threads (0.55 s to 1.18 s each); the named `accept` and `reader` threads are idle.

Attributed to the nearest frame of the helper's own binary above each sample (idb code is statically linked into `warden-simd`, so it counts as "own"):

| CPU-s | Share | Frame | Owner |
|---|---|---|---|
| 4.33 | 74 % | `BridgeJSONValue.init(from:)` (BridgeJSONValue.swift:62) | idb v1.7.2, `FBSimulatorBridgeProtocol` |
| 0.14 | 2.4 % | `JSON.encode(to:)` (Wire.swift) | warden-simd, response encoding |
| 0.12 | 2.0 % | `BridgeJSONValue.init(from:)` (compiler-generated) | idb |
| 0.11 | 1.9 % | `SimulatorXPCConnection.connect(service:lookup:)` | idb |
| 0.06 | 1.0 % | `BridgeJSONValue.encode(to:)` | idb (`accessibilityData()` re-encode) |
| 0.04 | 0.7 % | `NDJSON.encodeLine(_:)` | warden-simd |
| 0.04 | 0.7 % | `BridgeResponse.decode(_:for:)` | idb |
| 0.03 | 0.5 % | `AXBridgeSnapshotDecoder.snapshot(fromTree:pid:)` | idb |
| 0.03 | 0.5 % | `GuestReaper.guests(of:in:)` (Settle.swift:728) | warden-simd |
| 0.02 | 0.3 % | `QuiescenceMonitor.tracing.getter` (Settle.swift:263) | warden-simd |

Leaf self time (top 10 of the same window): `swift_release` 0.59 s, `swift_retain` 0.56 s, `OpaqueExistentialBox::initializeWithCopy` 0.46 s, `swift_arrayInitWithCopy` 0.39 s, `swift_arrayDestroy` 0.32 s, `_xzm_free` 0.19 s, `OpaqueExistentialBox::destroy` 0.18 s, `_xzm_xzone_malloc_tiny` 0.14 s, `start_wqthread` 0.14 s, `RefCounts::doDecrementSlow` 0.11 s. The wall-clock `sample` run puts `_CodingPathNode.path.getter`, `JSONDecoderImpl.decode`, `Dictionary.init(from:)` and `Array.init(from:)` right under it: this is Foundation's `JSONDecoder` building `DecodingError`s, not the parser.

The call path of the 74 %: `Session.snapshot` → `Session.withAX` → `AXBridgeUIAutomation.describe` → `AXBridgeTreeReader.describeTree` → `readRawTree` → `SimulatorFrameworkBridgePersistentTransport.send` → `roundTrip` → `BridgeResponse.decode` → `BridgeResult.init(from:)` → `BridgeJSONValue.init(from:)` (recursive, once per node and attribute of the accessibility tree).

## Why it is expensive

`BridgeJSONValue.init(from:)` is a try-each-case `Codable` decoder:

```swift
if value.decodeNil() { self = .null }
else if let bool = try? value.decode(Bool.self) { … }
else if let integer = try? value.decode(Int64.self) { … }
else if let integer = try? value.decode(UInt64.self) { … }
else if let number = try? value.decode(Double.self) { … }
else if let string = try? value.decode(String.self) { … }
else if let array = try? value.decode([BridgeJSONValue].self) { … }
else { self = .object(try value.decode([String: BridgeJSONValue].self)) }
```

Every string leaf of the tree (labels, identifiers, roles, values: most of a tree) throws four `DecodingError`s before it matches, every object throws seven, every array six, and each throw materialises the coding path (`_CodingPathNode.path.getter`) and boxes the error in an existential. Then `BridgeResponse.decode` decodes the frame twice (an `Envelope` for the version, then the full response), `BridgeResult.accessibilityData()` re-encodes the decoded value with `JSONEncoder`, and `AXBridgeTreeReader` decodes that `Data` a third time into the typed tree. One accessibility tree is parsed three times and the generic pass is the one that costs.

Scale: rep 2 made 166 `driver.snapshot` calls (15.95 s wall, 96 ms each), plus 41 `elementAtPoint`, 62 taps and 8 settles that read the tree as well. 4.3 CPU-s over ~170 tree reads is about 25 ms of CPU per read, a quarter of a snapshot's wall time, on the helper alone.

## Hypotheses, with evidence

| # | Suspect | Verdict | Evidence |
|---|---|---|---|
| H8 (new) | Generic `BridgeJSONValue` Codable decode of every bridge frame | **Confirmed, 74 % of helper CPU** | Time Profiler table above |
| H2 | Settle busy-loops (15 ms `Task.sleep` polls) | Killed as a CPU item | `Task.sleep` and `QuiescenceMonitor` frames total < 0.05 s in the window; 8 settles per rep, 2.13 s wall |
| H7 | Idle `SocketServer` / `StdioServer` loops | Killed | A resident helper after `warden ui open`: 0.14 s CPU over its life, zero on-CPU samples in 30 s |
| H1 | Guest recycling (`SimulatorFrameworkBridge-iOS serve`) | Sim-side, not host | 5.48 CPU-s per rep in the simulator, 9 spawns; every `driver.app.launch` span reports `rebindRecycled: true`. Untouched by this profile |
| H3 | Snapshot volume (166 per rep) | Multiplier of H8 | Fewer reads cut H8 linearly; after H8 the per-read cost is small |
| H4 | `bun test` child | Minor | 0.49 s per rep plus a 0.67 s exit charge, 15 % of host together |
| H5 | Spawn storms | Minor | `simctl` 0.27 s per rep, 3 spawns |
| H6 | Host RSS | Not a CPU item | Helper RSS 27 to 30 MB, `bun test` 46 to 53 MB |

Side finding, wall time not CPU: 17 `driver.typeText` calls took 19.12 s of the 63.6 s suite (1.1 s each). Worth its own look.

## Fix, ranked

1. **Stop decoding the tree generically** (idb, `FBSimulatorBridgeProtocol`): make `BridgeResponse.decode` parse the frame with `JSONSerialization` and convert with the existing `BridgeJSONValue(foundationValue:)` (no thrown errors, one C parse), or carry the accessibility value as raw `Data` on `BridgeResult` so `accessibilityData()` returns a slice and the tree is decoded once, by `AXBridgeTreeReader`. Expected: most of the 4.3 CPU-s per rep, i.e. about 55 % of warden's host CPU, and roughly 25 ms off every snapshot's latency. Lands as a patched checkout through `WARDEN_IDB_SRC` (`packages/e2e/native/scripts/deps.ts`) and an upstream pull request to facebook/idb.
2. **Read the tree less often** (`packages/e2e/src`, H3): observation reuse inside a poll tick and the 250 ms back-off `ui wait` already uses.
3. The helper's own encoding (`JSON.encode(to:)`, `NDJSON.encodeLine`, 0.2 s per rep) is the next line and not worth touching before 1 and 2.

Profiles, traces and the idb sources read for this are kept outside the repo; re-create with the setup above.

## Result of fix 1 (2026-10-25)

`BridgeResponse.decode` now parses a frame with one `JSONSerialization` pass and builds `result.values` with `BridgeJSONValue(foundationValue:)`; `BridgeResult` gained explicit `CodingKeys` so both paths name the same fields. The patch sits on idb v1.7.2 as commit [`1768a0d`](https://github.com/UrbanChrisy/idb/commit/1768a0d1006ff528c2fd78f335d9e3ee2f01596d) (branch `bridge-response-decode-once`, with a test that decodes every value shape through both paths and checks they agree). idb's library package built from it (macOS 26.5.2, Xcode 26.6, EAS run `01a17397`) is attached to the release [`idb-v1.7.2-warden.1`](https://github.com/delacournz/warden/releases/tag/idb-v1.7.2-warden.1), and `packages/e2e/native/idb.lock.json` pins that commit (`source`) and tarball (`url`, `sha256`), so every `native:deps` (CI, signoff, EAS, release) links the patched package.

Same setup as above (this Mac, pinned app, warden only, 3 reps, rep 1 cold; host loaded, so wall times are not comparable with the EAS numbers):

| Per rep (warm) | Before (`.bench/cpu-prof-2026-10-25`) | After (`.bench/cpu-32a-after`) | Delta |
| --- | --- | --- | --- |
| `warden-simd` CPU-s | 6.25 s | 1.68 s | -4.57 s (-73 %) |
| `warden-simd` share of host CPU | 80.3 % | 49.2 % | |
| `warden-simd` RSS peak | 28.6 MB | 28.6 MB | 0 |
| Suite median | 63.64 s | 59.20 s | -4.44 s (-7 %) |
| Pass rate | 100 % | 100 % | |

The 4.3 CPU-s the profile attributed to `BridgeJSONValue.init(from:)` is gone; what remains in the helper (1.68 s) is the `JSONSerialization` parse, the re-encode for `AXBridgeTreeReader` and the helper's own NDJSON encoding (fix 3). Headline, on EAS `macos-large` with the same workflow (warden only, 5 runs, run `01a1739d` at `a87b04cc` against run six `01a172f5`): host 9.12 → 3.79 CPU-s/rep (-58 %), `warden-simd` 7.03 → 1.83 s (-74 %), RSS peak 184.9 → 177.6 MB, suite median 97.04 → 91.89 s, 100 % pass both; published on the run page `apps/docs/content/docs/bench/ios-2026-10-25.mdx` with the artifact under `apps/docs/public/bench/ios-2026-10-25/warden-after/`. The simulator's own CPU over the whole job read higher on that worker (821 against 564 CPU-s, idle controls alike), so the in-simulator side is the next profile (H1, H3).

**Upstream status (2026-10-25):** Upstream already carries the same fix: facebook/idb #982 and #983 (typed `BridgeAnswer` models, `BridgeJSONValue` removed) shipped in v1.7.7 on 2026-10-22, so PR facebook/idb#991 from the fork was closed as obsolete; the follow-up is to bump the lock to v1.7.7 and drop the fork patch. warden-simd only calls `simulator.uiAutomation(backend: .accessibility)` in FBSimulatorControl, so the bump is a lock change plus a rebuild, not a port.

## Result of moving to idb v1.7.7 (2026-10-25)

The lock now pins v1.7.7's official library package and the fork is gone. Same local setup as above (this Mac, pinned app, warden only, 3 reps, host loaded):

| Per rep (warm) | Fork on v1.7.2 (`.bench/cpu-32a-after`) | v1.7.7 (`.bench/cpu-177`) | Delta |
|---|---|---|---|
| Host CPU-s | 3.46 | 2.87 | -17 % |
| of which `warden-simd` | 1.68 | 1.36 | -0.31 s |
| `warden-simd` RSS peak | 28.6 MB | 30.9 MB | +2.3 MB |
| Suite median | 59.20 s | 55.90 s | -5.6 % |
| Pass rate | 100 % | 100 % | |

Against the EAS baseline (`packages/e2e-bench/baselines/ios-warden.json`, 3.79 CPU-s/rep) the guard reads -24 %, so the baseline stays as the ceiling; it was taken on a hosted worker and is not refreshed from this machine.


## Read volume (2026-10-25, evening, this Mac)

Per warm rep the runner makes 183 `driver.snapshot`, 41 `driver.elementAtPoint` and 8 `settle` calls here (`.bench/snap-before`, warden only, 3 reps, pinned app, 100 % pass, suite median 53.58 s, host 3.09 CPU-s/rep: `warden-simd` 1.30–1.42, `bun test` 0.48, bun exit charge 0.58–1.15). The EAS worker's 221 reads per rep (`warden-after`, rep 3) are polling on a slower host: there the look taken 0–1 ms after a tap missed and the next poll caught the change; here it passes at once, because `driver.tap` only returns after the ~85 ms HID press and an AX read queues behind the app's main thread.

Tried, measured, reverted (`.bench/snap-after`): holding the first `tap({ until })` check to `pollMs` after the press and the first `expect` look to 100 ms after an input. 177 snapshots per rep (-6), host CPU unchanged (3.07), suite median 61.33 s (+7.7 s, every test +0.5 to +1.4 s). Not a lever on a fast host; `packages/e2e/AGENTS.md` ("Reads after an input") records it.

Kept (`.bench/snap-after2`): `settle` is a wait, not an input (a quiet one ends the last input), and the stable-frame second look of an action is one hit-test on iOS when no system alerts are answered. Bench suite (which sets `systemAlerts`, so the hit-test path is off): 182–183 snapshots per rep, host 2.85 CPU-s/rep, suite median 53.98 s, 100 % pass; against the EAS baseline the guard reads -24.9 % CPU and -42 % RSS. Read volume is worth at most ~0.3 of the ~3 CPU-s per rep on the host; what is left is the `bun test` exit charge (0.6–1.15 s/rep), the simulator-side guest recycling and, for specs with `systemAlerts`, whether an app-scoped hit-test can see a SpringBoard sheet (plan WDN-CPU2).

## The spec process and the "exit charge" (2026-10-25, evening, this Mac)

Instrumented run (`.bench/cpu2-prof`, warden only, 2 reps; `WARDEN_BUN` pointed at a wrapper that adds a timing preload logging `process.cpuUsage()`, keeps the child's rusage and takes a 30 s `sample` mid-rep):

| | |
|---|---|
| `bun test` CPU at the first `beforeAll` (preload + driver open) | 0.09 s |
| `bun test` CPU over the 54 s of tests | 0.44 s (≈ 2 ms per accessibility read) |
| `bun test` CPU total at `afterAll` | 0.52–0.53 s (= the sampler's `bun test` row) |
| `sample` of the process during a rep | 99.9 % of thread samples waiting (`__ulock_wait2`, `__psynch_cvwait`, `kevent64`) |
| `bun test --preload <warden preload>` on an empty spec | 0.03 s |

So the "bun test (exit charge)" row (0.58–1.15 CPU-s per rep) is not bun's startup or exit: it is the CPU of short-lived children of `bun test` that no 500 ms tick saw, booked to the root at its exit. Those children are the `xcrun simctl` invocations the iOS driver makes: `simctl launch --terminate-running-process` costs 0.13–0.16 CPU-s each (CoreSimulator loads in every invocation; `xcrun` itself 0.00, `plutil` 0.00), `terminate` 0.12, `openurl` 0.11, measured on a booted sim. One launch per `app.open` (8 per rep) plus `openurl` and the open-time probes come to about 1.2 CPU-s per rep: ~40 % of warden's host CPU, more than `warden-simd`'s 1.4 s, split between the visible `simctl` row and the exit charge. The spec process itself (zod on every reply, `snapshotHash`, transpile) is not worth touching.

Fix (plan WDN-CPU2, CPU2-4.2): launch, terminate and open-url through the resident helper, which already links FBSimulatorControl and has CoreSimulator loaded, with `simctl` as the fallback for an older helper. Expected: host ≈ 3.0 → ≈ 1.9 CPU-s per rep and 100–250 ms less wall per launch.

## Result of launching through the helper (2026-10-25)

`app.launch`, `app.terminate` and `app.openUrl` now run as ops inside the resident `warden-simd` (`launch{bundleId, args?, env?, terminateRunning?}` → `{pid}`, `terminate{bundleId}` → `{terminated}`, `openUrl{url}`), on the simulator framework the helper already links. Before, every `app.open` spawned one `xcrun simctl` per launch, and each of those processes loaded CoreSimulator from scratch: that was the `simctl` rows and most of the `bun test (exit charge)` row, since a short-lived child's CPU is charged to the parent on exit. Install, uninstall, `isRunning` and `clearData` stay on `simctl`; a helper that predates the ops answers `E_UNSUPPORTED` once and the driver falls back to `simctl` for the session. Same local setup (this Mac, pinned app, warden only, 3 reps, host loaded by another agent's sim + `warden dev` during both runs):

| Per rep (warm) | Before (`.bench/cpu2-4-before`) | After (`.bench/cpu2-4-after`) | Delta |
|---|---|---|---|
| Host CPU-s | 3.40 | 2.09 | -38.7 % |
| of which `warden-simd` | 1.57 | 1.48 | -0.09 s |
| `simctl` + `(simctl)` | 0.57 | 0.05 | -0.52 s |
| `bun test (exit charge)` | 0.63 | 0.06 | -0.57 s |
| `warden-simd` RSS peak | 30.8 MB | 37.2 MB | +6.4 MB |
| `driver.app.launch` median / p90 | 1895 / 2184 ms | 1768 / 1981 ms | -127 / -203 ms |
| Suite median | 63.23 s | 55.21 s | -12.7 % |
| Pass rate | 95.8 % | 100 % | |

Every `driver.app.launch` span in the after run carries `via: simd` and the app's `pid`. The sampler saw 5 host `simctl` starts over the before run and 1 after (it ticks, so it never counted all eight per rep; the CPU rows are the measure). The sim side also dropped (`iOS` 22.75 → 19.83 s, `(launchctl)` 0.72 → 0.23 s, `dtpasteboardd` 0.32 → 0): the simulator no longer services a fresh CoreSimulator client per launch. Against the EAS baseline (3.79 CPU-s/rep) the guard reads -45 %.

Parity, from the smoke's lifecycle leg on a claimed sim: launch args and env reach the app (both visible in `launchctl procinfo` of the launched pid), `relaunch` replaces the pid, `relaunch: false` keeps it, terminating twice is ok both times, and `openUrl` of the app's scheme link brings it to the front. One thing could not be shown here: on a fresh boot neither the helper's open nor `xcrun simctl openurl` raised the "Open in …?" sheet on this Mac, whether the app was running or not, so the bench's once-per-boot sheet priming is a no-op on this machine either way. The first hosted run decides whether the sheet behaves differently there.

Next on the host is what remains in the helper itself (1.48 s/rep, the AX read path) and the `bun test` runner (0.42 s); the sim side (CPU2-2) is now the larger share again.
