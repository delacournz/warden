# 01 · ios-helper-settle

Scope: `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift`, `Device/Session.swift`, and the settle/session/frontmost tests under `packages/e2e/native/ios/Tests/warden-simdTests`. Source read at `dfcc68b` (working tree `d6629f7` has no diff under `packages/`). No Swift toolchain or device here, so every finding is from reading and tracing the code; no Swift test was run.

## Top 5 by impact

- 01-2: a snapshot-fallback settle on a *booting* app (busy on both signals) passes the wedge test and ends healthy AX guests; the settle also answers `quiet` on a frame that is still booting.
- 01-1: `rebind` / `settle{bundleId}` ask launchd for the pid again every 150 ms while the stream disagrees, and stay blind while each 150-350 ms lookup is in flight, even though `simctl launch` already printed the pid. That is ~2.5-3.7 lookups and ~40-120 ms of added bind latency per launch.
- 01-3: the guest-recycle age is a constant 12 s and is only checked in `rebind`. Launch gaps of ~10.5-12 s still wedge on every other test, and suites that do not relaunch get no protection before the wedge.
- 01-4: `start()` called during `restart()`'s awaited teardown opens a second stream, so "never two streams" holds only while no other op is running. `stop()` does not await teardown at all.
- 01-5: the latched-stream back-off (`repeatRestartMs` 1500) counts from the restart decision, not from when the new stream opened. Under load a restarted stream is cut off before it can attach (~1.4 s needed).

## Findings

### 01-1 Bind and frontmost-gated settle re-resolve a pid they already have, and are blind during each lookup

- Category: perf-latency
- Severity: P2
- Known?: known-extended K18
- Evidence:
  - `QuiescenceMonitor.bind` (`packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:478-503@dfcc68b`): each 15 ms iteration calls `gate.shouldResolve`, which is true whenever the stream's pid differs from the target and ≥ `resolveEveryMs` (150 ms) has passed since the last lookup (`Settle.swift:194-198@dfcc68b`). This holds even when `targetPid` is already non-nil. `waitQuiet` does the same (`Settle.swift:556-566@dfcc68b`).
  - The resolver is `simulator.application.processID(forBundleID:)` (`packages/e2e/native/ios/Sources/warden-simd/Ops/Snapshot.swift:598-602@dfcc68b`). It is a launchd round trip of ~150 ms (`Snapshot.swift:596`), or 150-350 ms under load (`docs/plans/wdn-perf.md:93`).
  - The loop `await`s the lookup. The actor still applies stream events in the meantime, but the bound/quiet check only runs after the lookup returns, so a state for the target pid that arrives mid-lookup is seen up to one lookup later. The re-snapshot after the lookup (`Settle.swift:484`, `:564`) fixes the stale-decision race from PERF-0.4. It does not fix this delay.
  - The pid is already known on the TS side. `simctl launch` prints `<bundle>: <pid>`, but `simctl.ts` discards stdout (`packages/e2e/src/driver/ios/simctl.ts:248-251@dfcc68b`), and `rebind` sends only `{bundleId, rebindTimeoutMs}` (`packages/e2e/src/driver/ios/ios-driver.ts:268-272@dfcc68b`). After `--terminate-running-process` returns, the bundle's pid is final; it only changes on a crash or another launch.
  - K18 path: when `rebind` did not bind, the next `settle` carries `bundleId` (`ios-driver.ts:294-302`). For the whole default 5 s budget (`ios-driver.ts:79`) that settle runs a lookup every L+150 ms, i.e. 12-17 launchd lookups, plus restarts (01-5).
- Impact: estimated, iOS. Let L be the lookup time (150-350 ms). The fraction of bind time spent inside a lookup is f = L/(L+150), which is 0.5-0.7. Expected extra delay before a bind is noticed is f·L/2: 37 ms at L=150, 78 ms at L=250, 122 ms at L=350, with a worst case of L. Add ~7 ms mean from the 15 ms poll. A measured `rebind` takes 1097 ms (`wdn-perf.md:106`), which is 1097/(L+150) ≈ 2.7-3.7 lookups per launch, and those are host and simulator work too. That comes to ~40-130 ms per test and ~0.3-1.0 s per 8-launch rep.
- Proposed fix: (a) Swift: once `targetPid` is non-nil, stop re-resolving while `kill(targetPid, 0)` says it is alive (`Session.processExists`, `Snapshot.swift:612`); re-resolve only if it dies. (b) Add an optional `pid` to `rebind` (and `settle`) params. `simctl.launch` parses `bundle: pid` and passes it on, so the gate starts resolved and makes zero lookups. (c) Optional: have `apply()` resume a waiter continuation instead of 15 ms polling. Files: `Ops/Settle.swift` (`FrontmostGate`, `bind`, `waitQuiet`, `RebindRequest`/`SettleRequest`), `src/driver/ios/simctl.ts`, `ios-driver.ts`, `simd-protocol.ts`. Contract: additive wire field (optional param). An old helper ignores unknown params.
- Effort: S (a), M (a+b)
- Risk: low. A process that dies and is replaced under the same bundle during the wait is caught by the liveness check. Wall-time gain needs a device.
- How to verify: Swift test that counts `PidScript.calls` during a bind where the target pid is known from the first call and the stream follows after 600 ms (expect 1 call, today 3-4). On device: `rebindMs` span detail over 3 reps before and after, plus helper `--trace` `bind resolved` lines per launch.
- Confidence: high (mechanism), med (size)
- Verified by: traced path from `ios-driver.ts` `app.launch` to `simctl.launch`, then `rebind`, `RebindPrelude`, `QuiescenceMonitor.bind` and `resolveBundlePid`

### 01-2 A booting app reads as a wedged guest: the snapshot fallback answers early and the reap kills healthy guests

- Category: flake-risk
- Severity: P2
- Known?: known-extended K7 (also K18)
- Evidence:
  - A stream is "stuck" when the state is `busy` with every signal (`StuckTracker.isStuck`, `Settle.swift:131-134@dfcc68b`). The helper's own test says a booting app looks exactly like this: "A booting app answers no quiescence signal for a while: the stuck-stream restart reopens the stream" (`packages/e2e/native/ios/Tests/warden-simdTests/SettleFrontmostTests.swift:233-235@dfcc68b`).
  - `SettleJudge` restarts at 400 ms and falls back at 700 ms (`Settle.swift:113-123`). The fallback answers `quiet:true via:"snapshot"` from two identical reads ≥ `max(quietMs,150)` apart (`Settle.swift:597-604`). A splash or launch screen is static, so it passes, and the app is still booting when it does.
  - `Session.settle` then calls `reapWedgedGuests()` on any `via:"snapshot"` (`Settle.swift:861`). `WedgePolicy.shouldReap` only asks for ≥1 earlier stream-quiet in this guest generation and 5 s since the last reap (`Settle.swift:637-641`). Every settle that went `via:"stream"` before the relaunch satisfies the first condition, so a busy boot ends every guest of the simulator (`GuestReaper.reap`, `Settle.swift:736-740`) and restarts the stream.
  - The policy ignores guest age, the one strong discriminator. Measured wedge onsets are 21.4-26.5 s after a guest starts (`docs/plans/wdn-perf.md:94@dfcc68b`), and with recycling at 12 s (`Settle.swift:635`) guests rarely get that old.
- Impact: estimated, iOS. Each false reap costs the reap itself (~0.2-0.3 s, see 01-9) plus a first read after a reap of 290-580 ms against 21-90 ms (`wdn-perf.md:88`), so ≈ 0.5-0.8 s. The premature `quiet` gives no timing gain and can become a wrong-screen assertion or a mis-tap later. How often it happens depends on how long the app's boot is stuck. The bench example app shows 8/0 `via:"stream"` per rep (`wdn-perf.md:104`), so it does not trigger there. It does trigger in the K18 situation (settle during a 4.5-6.4 s boot).
- Proposed fix: add `minWedgeAgeSeconds` (e.g. 18) to `WedgePolicy` and pass `wedge.guestAge()` into `shouldReap`. Below that age a fallback means "busy app", not "wedged guest". Optionally report `reason:"stuck"` on a snapshot verdict so the TS side can tell it apart from a stream quiet. Files: `Ops/Settle.swift` (`WedgePolicy`, `WedgeWatch.wantsReap`, `Session.settle`). Contract: additive.
- Effort: S
- Risk: low. A real wedge under 18 s of age has not been observed. If one occurs, the next settle after the age threshold still reaps.
- How to verify: `WedgeTests` cases for `shouldReap(streamQuiets:1, guestAge:5)` → false and `guestAge:22` → true. On device: settle right after `simctl launch` of a slow-booting build with `--trace`, and look for `ended N AX guest(s)` at guest age < 18 s in the helper log.
- Confidence: med
- Verified by: read (`Settle.swift` judge, reap path, and the test comment on booting apps)

### 01-3 Guest recycling uses a constant 12 s age and only checks it at `rebind`

- Category: robustness
- Severity: P2
- Known?: known-extended K7
- Evidence:
  - `WedgePolicy.recycleAfterSeconds = 12` (`Settle.swift:635@dfcc68b`), overridable only by `WARDEN_SIMD_GUEST_MAX_AGE_S` (`Settle.swift:651-660`). It is checked once per `rebind` (`RebindPrelude.run`, `Settle.swift:794`), so once per launch. `settle` and reads never check it.
  - The comment says it is tuned to ~8 s launch gaps (`Settle.swift:629-632`, `docs/plans/wdn-perf.md:106`).
  - Arithmetic, with launch gap g, wedge onset W ≈ 21 s, and threshold 12. A test that starts at guest age a < 12 runs until a+g and wedges if a+g > W. Gaps of g ≤ 9 s are safe. For 10.5 < g < 12 the first launch is at age g < 12 (no recycle), and the next test runs from g to 2g > 21, so it wedges on alternating tests. For g ≥ 12 every launch recycles (+0.51 s each, `wdn-perf.md:106`). Any test longer than ~21 s, or a suite that does not relaunch between tests, never reaches `rebind` and relies on the reactive reap (1.25 s settle + ~0.45 s, `wdn-perf.md:106`).
  - Short gaps recycle more often than they need to. At g = 4 s the constant recycles every 3rd launch, while age + g + margin(2 s) > 21 would recycle every 4th.
- Impact: estimated, iOS. Suites with 10.5-12 s tests pay ~1.7 s per wedged test on about half their tests: ~0.85 s per test, ~6.8 s per 8-test rep. A suite with 4 s tests saves 0.51 s × (1/3 − 1/4) ≈ 40 ms per test. The bench suite (~8 s) is unchanged.
- Proposed fix: `WedgeWatch` records `rebind` times and keeps an EWMA of the launch gap ĝ. It recycles when `age + ĝ + margin ≥ wedgeOnset` (`wedgeOnset` 21 s, margin 2 s). An explicit `WARDEN_SIMD_GUEST_MAX_AGE_S` still wins. With no history yet it falls back to 12 s. Optionally also recycle on a `settle` when `age ≥ wedgeOnset − 1` and no rebind is expected. Files: `Ops/Settle.swift` (`WedgePolicy`, `WedgeWatch`, `RebindPrelude`). Contract: additive, but changes a tuned default, so `policy_change: true`.
- Effort: M
- Risk: med. W comes from one device and iOS version (21.4-26.5 s). Verify on device with suites of different cadence.
- How to verify: `RecycleTests` with an injected `now`: gaps of 4, 8 and 11 s and the recycle decisions at each launch. On device: the bench at default plus a padded variant (add `await sleep(3000)` per test), counting `via:"snapshot"` and `rebindRecycled` per rep.
- Confidence: med
- Verified by: read and arithmetic over `wdn-perf.md:94,100-106`

### 01-4 `start()` during an awaited `restart()` opens a second stream; `stop()` never waits for teardown

- Category: flake-risk
- Severity: P2
- Known?: new (the PERF-0.4 "restarts raced themselves" fix, `wdn-perf.md:93`, covers restart against restart only)
- Evidence:
  - `restart()` sets `task = nil`, cancels, then `await old?.value` (`Settle.swift:410-416@dfcc68b`). Its doc says the old task "may still be inside its open call (cancelling it does not abort the open), so this can take as long as that open does" (`Settle.swift:405-406`), which is seconds under load (`Settle.swift:364-365`).
  - During that await the actor is re-entrant. `start()` only checks `guard task == nil` (`Settle.swift:273`), so any op entering then creates a new task that calls `reader.quiescence(...)` while the old open is still in flight: `waitQuiet` (`:541`), `bind` (`:473`), `recover` (`:437`), the `frontmost` op (`Snapshot.swift:584`) or `warmQuiescence` (`Settle.swift:834`). `restart()` then sees `task != nil` and returns (`:417`). Two opens are in flight at once, which is exactly the "two streams leave each other stuck" case (`Settle.swift:314-316`).
  - Ops do run concurrently. `StdioServer` adds every line as its own task (`packages/e2e/native/ios/Sources/warden-simd/Server/StdioServer.swift:110-114@dfcc68b`), and the socket serves many clients (`warden ui` alongside `warden e2e`).
  - Restarts that can find the old task still opening: `recover` (unconditional after its follow window, `Settle.swift:448`) and `GuestRecycling.endGuests` (`:780`). The gate restarts are guarded by `isStillOpening`, but these two are not.
  - `stop()` (idle close, `Settle.swift:300-310`, `:328-332`) cancels without awaiting. The old task later runs `reset()` (`:294`, `:356-362`), which clears `openingSince`/`streamOpen` of a stream that a following `start()` has just begun. `isStillOpening` then says false and a gate restart can fire on a stream that is still opening. This only happens when `WARDEN_SIMD_STREAM_IDLE_S` is set.
- Impact: estimated, iOS. When it happens, settles fall back to `via:"snapshot"` (~2.5 s instead of ~260 ms, `packages/e2e/AGENTS.md:65@dfcc68b`) until the extra open is dropped. How often depends on concurrent ops. Sequential e2e flows rarely hit it; `warden ui` against a running suite, or a read failing during a recycle, can.
- Proposed fix: keep `private var teardown: Task<Void, Never>?` set during `restart()`/`stop()`. `start()` (made `async`) first awaits a pending teardown, or returns while `restarting` is true and lets the restarter open. `stop()` keeps the old task in `teardown`, and `reset()` from a superseded task becomes a no-op (generation counter). Files: `Ops/Settle.swift` (`QuiescenceMonitor`). Contract: additive.
- Effort: S
- Risk: low. Callers of `start()` may wait one open longer.
- How to verify: `RebindTests`: with `holdOpens = true`, start, then `Task { await monitor.restart() }`, then `await monitor.start()` during the hold. Assert `reader.requests == 1` until `releaseOpens()`, and exactly 2 afterwards. Same pattern for `stop()` followed by `start()` with `idleCloseSeconds`.
- Confidence: med (mechanism high, frequency unknown)
- Verified by: read (actor re-entrancy across `await old?.value`)

### 01-5 The latched-stream back-off is counted from the restart decision, so slow opens starve the bind

- Category: flake-risk
- Severity: P2
- Known?: new (touches the K18 path)
- Evidence:
  - `FrontmostGate.shouldRestart` repeats every `repeatRestartMs` (1500) measured from `lastRestartAt`, which is the moment the restart was decided (`Settle.swift:215-224@dfcc68b`, set at `:498`, `:575`).
  - The only protection for the new stream is `isStillOpening` (`Settle.swift:389-393`): true while it opens, then for `bindGraceSeconds` 0.5 s after opening, and only while `frontmostPid == nil`. A restarted stream on a still-launching app first reports the old frontmost app, and the gate doc says a restarted stream "needs ~0.2 s to open plus ~1.2 s to attach to an app that is still starting" (`Settle.swift:169-171`). The repair loop's own doc says the opposite ("a fresh stream takes ~0.6 s to bind", `:211`).
  - So when an open takes o ms, the new stream gets 1500 − o ms after opening before it is restarted again. With o ≥ ~300 ms (normal under load, "seconds on a loaded one", `Settle.swift:364-365`) that is less than the ~1.2 s attach. Every restart is then cancelled before it binds, until `settle` ends `frontmost_mismatch` or `rebind` ends `timeout`.
  - Test coverage: `testALatchedRestartIsRetried` (`SettleFrontmostTests.swift:305-322`) uses instant opens. No test combines `openDelay` with an old-pid report.
- Impact: estimated, iOS, loaded host only. A `settle{bundleId}` or `rebind` that never binds costs its full budget (rebind 3 s, `ios-driver.ts:82`; settle 5 s) plus ~1.5 s on the first read (`wdn-perf.md:92`).
- Proposed fix: count the repeat back-off from the new stream's `openedAt` (the monitor knows it; pass it into the gate or check `now - openedAt >= followGrace` inside `isStillOpening`), with followGrace = `firstRestartGraceMs` (0.9 s). Files: `Ops/Settle.swift`. Contract: additive.
- Effort: S
- Risk: low. A latched stream on a fast host is restarted slightly later (≤ 0.9 s after open instead of 1.5 s after the decision).
- How to verify: Swift test with `reader.openDelay = .milliseconds(1200)`. The stream reports springboard and is restarted; the new stream reports springboard, then the app 1.0 s after opening. Assert `opened == 2` (today it is 3+).
- Confidence: med
- Verified by: read

### 01-6 The lifetime stream stays open while no client is connected, on a resident helper

- Category: perf-cpu
- Severity: P2
- Known?: new (relates to K12, but the guest is counted in the bench's `sim` scope, not `host`)
- Evidence:
  - The stream is opened at helper start (`packages/e2e/native/ios/Sources/warden-simd/main.swift:54@dfcc68b`, `Settle.swift:832-835`) and stays open for the helper's life by default (`Settle.swift:244-258`, `:312-317`). `WARDEN_SIMD_STREAM_IDLE_S` is off by default.
  - The helper is resident after release with a 600 s idle timeout (`packages/e2e/native/ios/Sources/warden-simd/Arguments.swift:42@dfcc68b`, `packages/e2e/AGENTS.md:63`). So for up to 10 min after a run the in-simulator guest keeps sampling the frontmost app with `quietWindow 0.05` (`Settle.swift:279-280`), and the helper handles every event: an actor hop, plus `Self.trace` reading the whole `ProcessInfo.processInfo.environment` dictionary for each event, because `tracing` is a computed `static var` (`Settle.swift:263`, `:335`).
  - Closing it costs the next run nothing. The guests are > 12 s old by then, so the next run's first `rebind` recycles them and restarts the stream anyway (`Settle.swift:794-797`). The guest has wedged after ~26 s idle (`wdn-perf.md:94`), so an idle stream is also probably reporting stuck states for most of those 10 minutes.
- Impact: not measured; the sampler has no per-process split (K2). The cost is the guest's and helper's CPU for up to 600 s per run on the simulator, and the cost of the extra stream while another tool uses the simulator (`AGENTS.md:65`: two streams stall each other, which is relevant when the bench switches frameworks).
- Proposed fix: in socket mode, close the stream (`monitor.stop()`) when the last client disconnects (`IdleTracker` already tracks clients) and warm it again on connect. Make `tracing` a `static let`. Files: `Ops/Settle.swift`, `Server/SocketServer.swift` (agent owning the server), `main.swift`. Contract: additive. `policy_change` true (stream lifetime default).
- Effort: S
- Risk: low. The first `settle` of a run with young guests (< 12 s, i.e. a reconnect within 12 s) pays a ~0.5 s open, which warm-on-connect hides.
- How to verify: on device, after a bench run, run `ps -o pid,%cpu,rss -p <warden-simd pid>,<SimulatorFrameworkBridge-iOS serve pids>` every 1 s for 120 s, with the default and with `WARDEN_SIMD_STREAM_IDLE_S=1`. Count `event` lines per second with `--trace`.
- Confidence: low (size), high (mechanism)
- Verified by: read

### 01-7 Stream quiet cannot see JS-thread work, so `app.open({wait:"quiet"})` settles on the splash

- Category: correctness
- Severity: P2
- Known?: known-extended K15
- Evidence:
  - The stream verdict is `.quiet` held for `quietMs`, counted from `max(since, begun)` (`Settle.swift:583`). The guest's signals are the main run loop idle and Core Animation inactive (`QuiescenceSignal`, `Settle.swift:104-107`).
  - In an RN/Expo app the bundle loads and the first render is computed on the JS thread while the native launch screen is static, so the main run loop is idle and no animation runs. The stream truthfully says `quiet` before any JS view exists.
  - After `rebind` binds, the `settle` carries no `bundleId` (`ios-driver.ts:468-469`), so nothing else holds it back. This matches the bench note that the `app.open` settle "runs before the welcome screen is visible" (`docs/bench/ios-2026-10-16-perf.md:141@dfcc68b`: 2.6 s vs 2.2 s of settle per rep).
- Impact: measured symptom (bench, above); the mechanism is inferred. The cost is a settle that does not hold back what follows, so the next `toBeVisible` pays the render time instead.
- Proposed fix: a content condition on settle, e.g. `settle{bundleId, minNodes|treeChanged:true}` that also needs the frontmost tree to differ from the first post-launch read (two reads the helper already knows how to take, `readFrame`), or have `app.open` wait for a locator. Files: `Ops/Settle.swift` (optional param), `ios-driver.ts` / `open.ts` (agent 03). Contract: additive wire param.
- Effort: M
- Risk: med. Apps whose launch screen is identical to the first frame never satisfy `treeChanged`, so it needs a budget fallback.
- How to verify: on device, `--trace` during `app.open({wait:"quiet"})`, comparing the time of `settle quiet after` with the first snapshot that contains the welcome element.
- Confidence: low
- Verified by: read, plus the bench doc

### 01-8 The stuck-stream restart at 400 ms has helped in no measured case

- Category: perf-cpu
- Severity: P3
- Known?: new
- Evidence: `SettleJudge.restartAfterMs = 400` restarts once before the 700 ms fallback (`Settle.swift:114-121@dfcc68b`, `:589-596`). The code's own notes say a stream stuck after a relaunch "has not recovered on a restart in any measured run" (`Settle.swift:109-112`), and that a wedged guest survives "any number of stream restarts" (`Settle.swift:621-623`, `wdn-perf.md:94`). On a booting app a restarted stream needs ~1.2 s to attach (`Settle.swift:169-171`), and the fallback fires at 700 ms anyway, because `StuckTracker` keeps counting through the restart's `nil` states (`Settle.swift:136-143`). On a wedge, the reap that follows restarts the stream again (`Settle.swift:780`), so each wedge opens two streams.
- Impact: estimated, iOS. One extra stream open (~0.5 s of guest work, `Settle.swift:231`) running alongside the fallback's tree reads on every snapshot-fallback settle. The wall-time effect depends on whether the guest serialises opens and reads; not measured.
- Proposed fix: default `restartAfterMs` to nil or ≥ `fallbackAfterMs` (no restart), and let the reap do the only restart. Files: `Ops/Settle.swift`, `SettleTests.swift:32-45`. Contract: additive.
- Effort: S
- Risk: low/med. The two-helpers-on-one-simulator case (`Settle.swift:104-107`) is not fixed by a restart either (`AGENTS.md:65`).
- How to verify: on device, the wedge probe from PERF-0.4 with and without the restart; compare `via:"snapshot"` settle ms.
- Confidence: med
- Verified by: read

### 01-9 The wedge reap runs on the settle's reply path

- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `Session.settle` computes `waitedMs` and then `await reapWedgedGuests()` before returning the reply (`Settle.swift:859-865@dfcc68b`). The doc says "this runs after the settle's own verdict, so its wait is not charged to it" (`Settle.swift:869-870`), which is true for `waitedMs` but not for the client's latency. The reap is a synchronous `ps` (`Settle.swift:751-763`), SIGTERM, a fixed 150 ms sleep (`:779`) and an awaited `restart()` (`:780`).
- Impact: estimated, iOS. ~0.2-0.3 s per reap (150 ms sleep + `ps` 30-100 ms + restart). Rare with recycling on (0 wedges in 24 launches, `wdn-perf.md:104`); it adds to the 1.25 s wedge settle otherwise.
- Proposed fix: return the reply first and run the reap in a `Task`. This depends on 01-4: a detached restart must not race the next op's `start()`. Files: `Ops/Settle.swift`. Contract: additive.
- Effort: S
- Risk: low after 01-4. The next read may hit an ending guest; `readRecovering` covers it (`Snapshot.swift:177-187`).
- How to verify: Swift test with a fake reaper whose `list` sleeps 200 ms: the reply arrives before the reaper is called.
- Confidence: high
- Verified by: read

### 01-10 Recycling blocks a concurrency thread on `ps` and sleeps a fixed 150 ms

- Category: perf-latency
- Severity: P3
- Known?: known-extended K7 (the +0.51 s recycle cost)
- Evidence: `GuestReaper.system.list` runs `/bin/ps -axo pid=,ppid=,command=` with `readDataToEndOfFile` and `waitUntilExit`, synchronously inside the async `endGuests` (`Settle.swift:751-763@dfcc68b`, `:776`), which blocks one cooperative-pool thread for the whole spawn. It then parses every process's full command line (`:743-749`) to find one `launchd_sim` and its children. After SIGTERM it sleeps a fixed 150 ms (`settleSeconds`, `Settle.swift:774`, `:779`) without checking whether the guests have exited.
- Impact: estimated, iOS. `ps` over ~1000 host processes is ~30-100 ms. The fixed sleep is ~100 ms longer than needed if guests exit within ~50 ms of SIGTERM. That is ~0.1-0.2 s of the measured +0.51 s per recycle (`wdn-perf.md:106`), and recycles happen on 11 of 24 launches, so ~50-90 ms per test averaged.
- Proposed fix: cache the simulator's `launchd_sim` pid. Enumerate children with `proc_listchildpids` and match `proc_pidpath` against `SimulatorFrameworkBridge-iOS`. Poll `kill(pid,0)` every 10 ms up to 150 ms instead of a fixed sleep. Files: `Ops/Settle.swift` (`GuestReaper`, `GuestRecycling`), `WedgeTests.swift`. Contract: additive.
- Effort: M
- Risk: low/med. `proc_pidpath` does not carry `serve` args; it only has to match the guest binary, which is the same set.
- How to verify: the existing `WedgeTests` with an injected list, plus on device the `rebindMs` of recycled launches (`rebindRecycled:true`) before and after.
- Confidence: med
- Verified by: read

### 01-11 `frontmost` asks launchd on every call while another app is in front

- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `Session.frontmost` answers from memory only when the cached pid equals the stream's frontmost pid and is alive (`Snapshot.swift:586-591@dfcc68b`, `:606-609`). Otherwise it resolves again (`:592`). While Safari or SpringBoard is in front, the cached pid is alive but not frontmost, and the answer (`false`) cannot change without a lookup unless the app's process died. `openLink` polls `appInFront` every 250 ms after the 1.2 s window for up to 8 s (`packages/e2e/src/device-link.ts:10-14@dfcc68b`, `:124-128`, `:173`).
- Impact: estimated, iOS. Up to ~(8 − 1.2)/(0.25 + 0.15) ≈ 17 launchd lookups per slow `openLink`. Hand-over is noticed up to one lookup (150-350 ms) late, ~75 ms on average.
- Proposed fix: when the cached pid is alive, answer `cached == frontmost` without a lookup, and look up only when the cached pid is missing or dead. Files: `Ops/Snapshot.swift` (agent 02's file; the policy is shared with `BundlePidMemory`). Contract: additive.
- Effort: S
- Risk: low. pid reuse within one helper's life is negligible, and a relaunch kills the old pid, which forces the lookup.
- How to verify: a pure test of the new `cachedPidAnswer(cached:frontmost:isAlive:)` returning false without a lookup; on device, count `--trace` lookups during `openLink`.
- Confidence: high
- Verified by: traced path from `device-link.ts` `handedOver` to `driver.isFrontmost` and `Session.frontmost`

### 01-12 Monitor timing runs on the real clock; the snapshot fallback and the reap trigger are untested

- Category: test-gap
- Severity: P2
- Known?: new
- Evidence:
  - The pure rules take an injected `now`: `FrontmostGate` (`SettleFrontmostTests.swift:134-187`), `SettleJudge`/`StuckTracker`/`FrameStability` (`SettleTests.swift`), and `WedgePolicy`/`WedgeWatch` (`WedgeTests.swift`, `RecycleTests.swift:31-72`).
  - `QuiescenceMonitor` reads `ProcessInfo.systemUptime` through a static `clock()` (`Settle.swift:260@dfcc68b`). `openingPatienceSeconds`, `bindGraceSeconds` and `recoverFollowMs` are `static let` (`:370-372`, `:426`). The monitor tests therefore sleep for real: 13 `Task.sleep` calls in `SettleFrontmostTests.swift` (1.7 s at `:197`, 1.5 s at `:270`, 0.9 s at `:248`), 10 in `RebindTests.swift` and 4 in `RelaunchRecoveryTests.swift`. Their comments record flakes from that ("a sleep racing a delay flaked on a loaded CI runner", `SettleFrontmostTests.swift:264-265`; "a scheduling stall ... turned a missed restart into a hung `swift test`", `:60-61`).
  - `FakeReader.describe` always throws (`SettleFrontmostTests.swift:77-79`), and `readFrame` errors are swallowed by `try?` (`Settle.swift:598`), so no test ever reaches `via:"snapshot"`. The only `via` assertion is `"stream"` (`SettleFrontmostTests.swift:255`).
  - `Session.settle`'s `noteStreamQuiet` and `reapWedgedGuests` wiring (`Settle.swift:860-861`) needs a real `Session` and is untested. Covered only on device: wedge onset, recycle cost, repeat-restart cadence under slow opens (01-5), and the booting-app fallback (01-2).
- Impact: estimated. The fallback path is the wedge safety net, and a regression there would show up only on device. The real-time sleeps cost ~5-8 s of wall time per `swift test` run.
- Proposed fix: inject `clock: @Sendable () -> Double` and `sleep` into `QuiescenceMonitor.init` (defaults unchanged), make the three constants `init` parameters, and give `FakeReader.describe` a scripted document list. Extract the settle-reply decision (`noteStreamQuiet`, reap) into a pure function over `Outcome`. Files: `Ops/Settle.swift`, `Tests/warden-simdTests/*`. Contract: additive.
- Effort: M
- Risk: low
- How to verify: new test `testAStuckStreamFallsBackToTwoEqualReads` (scripted describe returns the same doc twice → `via:"snapshot"`, ~700 + 150 ms on a virtual clock). `swift test` wall time before and after.
- Confidence: high
- Verified by: read

## Known items

- K7 known-extended: the reap discriminator ignores guest age (01-2); the recycle threshold is constant and checked only at rebind, with the arithmetic for which launch gaps fail (01-3); about 0.1-0.2 s of the +0.51 s recycle is `ps` plus a fixed sleep (01-10).
- K15 known-extended: stream quiet measures the main run loop and Core Animation only, so a static launch screen during JS load counts as quiet (01-7).
- K18 known-extended: `settle{bundleId}` during a boot runs a lookup every L+150 ms (12-17 lookups in a 5 s budget), restarts every 1.5 s counted from the decision (01-1, 01-5), and the snapshot fallback can answer quiet on the boot screen and reap guests (01-2).
- K9 not touched (no key pacing in scope).
- Non-K hotspots checked, no finding: `BundlePidMemory` + `kill(pid,0)` is correct across relaunch (`rebind` forgets the pid, `Settle.swift:793`; a dead cached pid forces a lookup, `Snapshot.swift:606-614`). pid reuse needs a 99 999 wrap within one helper's life and the stream reporting that pid, which is negligible. Polling loops in `Settle.swift`: stream reopen back-off 200 ms (`:295`); idle watch 250 ms, only with `WARDEN_SIMD_STREAM_IDLE_S` (`:322`); `recover` follow poll 15 ms for ≤ 900 ms (`:445`) and its post-restart state poll 25 ms (`:450`); `bind` 15 ms (`:503`); `waitQuiet` 15 ms (`:579`, `:613`) with fallback reads ≥ 100 ms apart (`:598`); recycle settle sleep 150 ms (`:779`). The 15 ms polls cost ~67 actor wakeups/s per waiting op, which is negligible CPU but adds a mean 7.5 ms per verdict. `restart()` against a stream still in `for try await`: cancelling the AsyncThrowingStream iteration ends the old task promptly, and the awaited teardown in `restart()` works as claimed (`wdn-perf.md:93`, fix landed at `Settle.swift:408-422`). PERF-1.2 item 4 (`fallbackAfterMs` 2000 → 700) landed (`Settle.swift:115`). PERF-1.2 item 3 ("restart at once on a dead pid") was deliberately not done (`wdn-perf.md:110`) and the 900 ms grace is in place (`Settle.swift:175`).

## Gaps I could not assess here

- Whether idb's `quiescence` stream closes its guest-side subscription when the Swift iterator is cancelled, or when an open completes after cancellation. This decides whether 01-4 leaves two live streams or only a short overlap. On device, run `ps -axo pid,ppid,command | grep 'SimulatorFrameworkBridge-iOS serve'` every 30 ms while forcing `recover` during a held open (use `--kill-bridge` from `native/scripts/smoke.ts`).
- Idle cost of the lifetime stream (01-6). Run `ps -o %cpu,rss` for the helper and its guests over 120 s idle, comparing the default against `WARDEN_SIMD_STREAM_IDLE_S=1`, and count events per second with `--trace`.
- How often a booting app is stuck on both signals for ≥ 700 ms (01-2). Run `WARDEN_SIMD_TRACE=1`, then `simctl launch` followed immediately by `settle{bundleId}`, 20 cycles, and count `settle quiet by snapshot stability` and `ended N AX guest(s)` lines at guest age < 18 s.
- Real launchd lookup time and count per `rebind` (01-1). Grep `bind resolved` lines per launch in a `--trace` bench run and take the gap between the `bind begin` and `bind bound` timestamps.
- Repeat-restart starvation under load (01-5). Run the relaunch probe with `stress -c 14` alongside, then count `restarts` and `reason:"timeout"` in `rebind` replies.
- Wedge onset for other iOS/Xcode versions, needed before an adaptive threshold (01-3) replaces the constant.

## Owned files not read

- `Tests/warden-simdTests/` files that belong to agent 02 (model/codec: `ElementTests`, `SnapshotFixtureTests`, `DocumentFixture`, `EmptyRootTests`, `NDJSONTests`, `AlertBackendTests`, `KeyboardTests`, `InputTests`, `AnnounceTests`, `ArgumentsTests`, `DispatcherTests`, `ErrorMappingTests`, `SocketServerTests`) were not read in full. `ErrorMappingTests` covers `Session.swift`'s `WireError.from`, which I read but found nothing in.

## Questions for the user

- Can the helper be given the pid from `simctl launch`, i.e. may `rebind`/`settle` grow an optional `pid` param (01-1b)? If not, only the Swift-side "stop re-resolving a live pid" part applies.

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-01.md
- packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift (all)
- packages/e2e/native/ios/Sources/warden-simd/Device/Session.swift (all)
- packages/e2e/native/ios/Sources/warden-simd/Ops/Snapshot.swift:150-360, 560-635 (context: `readRecovering`, `recoverBridge`, `frontmost`, `resolveBundlePid`, `BundlePidMemory`)
- packages/e2e/native/ios/Sources/warden-simd/Server/Dispatcher.swift:1-80, Server/StdioServer.swift:105-120, main.swift:40-70, Arguments.swift (grep)
- packages/e2e/native/ios/Tests/warden-simdTests/SettleTests.swift (test list), SettleFrontmostTests.swift (all), RebindTests.swift:1-130 + test list, RecycleTests.swift:1-30, 86-110 + test list, RelaunchRecoveryTests.swift:110-175 + test list, WedgeTests.swift (test list)
- packages/e2e/src/driver/ios/ios-driver.ts:75-95, 268-320, 355-358, 465-476; simctl.ts:240-275; packages/e2e/src/device.ts:95-200; packages/e2e/src/device-link.ts:1-20, 110-215
- packages/e2e/AGENTS.md (grep, lines 57-80), docs/plans/wdn-perf.md:39-45, 76-112, 175-190, 688; docs/bench/ios-2026-10-16-perf.md (all)
