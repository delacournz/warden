# Assignment 01 · `ios-helper-settle` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/01-ios-helper-settle.md` and `docs/audit/raw/01-ios-helper-settle.jsonl`.

## Improvement goal

Make the iOS `settle` and launch-bind path faster and steadier, with fewer AX-guest recycles and less CPU spent by the quiescence stream in the `warden-simd` helper.

## Owned files

- `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift` (910 lines: `QuiescenceMonitor`, `SettleJudge`, `FrontmostGate`, `RebindPrelude`, `WedgePolicy`, `GuestReaper`, `WedgeWatch`, `BundlePidMemory`)
- `packages/e2e/native/ios/Sources/warden-simd/Device/Session.swift`
- `packages/e2e/native/ios/Tests/warden-simdTests/**` (the settle/session/frontmost tests; the model/codec tests belong to agent 02)
- Read-only context: `packages/e2e/AGENTS.md` § `warden-simd` internals (settle, rebind, frontmost, wedged guest, relaunch repair), `docs/plans/wdn-perf.md` § PERF-0.4 root cause and § PERF-1.2, `docs/plans/wdn-e2e.md` "Fix for open item 1" and "Relaunch bug bisect".

Not yours: `Ops/Snapshot.swift` (agent 02, cite it when `readRecovering` matters), the TS side `ios-driver.ts` (agent 03).

## Starting hotspots (confirm or refute each, with lines)

- `FrontmostGate.Timing`: pid re-resolved every 150 ms (a `launchctl` lookup costs 150–350 ms under load), 900 ms grace before the first restart, 1.5 s repeats; what does a settle cost in process spawns and wakeups while the app boots (K18)?
- `WedgePolicy` / `GuestReaper` (K7): `ps` per reap, 5 s reap cooldown, `WARDEN_SIMD_GUEST_MAX_AGE_S` 12 s tuned to one suite's launch cadence. Is the age check per launch, per settle or per read? What does a recycle cost on the launch path (+0.51 s measured)? Can the threshold follow the observed launch gap instead of a constant?
- `recoverFollowMs` 900, `restartAfterMs` (400 ms of `busy`) and `fallbackAfterMs` (700 ms) in `SettleJudge`: how often does the snapshot fallback fire on a healthy app, and what does it cost (two tree reads)?
- `QuiescenceMonitor.restart()` awaited teardown: trace the cancellation path for a stream still inside its open call; any way two streams can coexist?
- `warmQuiescence` at helper start (`Task { … }`), stream idle default off (`WARDEN_SIMD_STREAM_IDLE_S`): CPU of a lifetime stream sampling on an idle sim; what does `--trace` show per sample?
- `BundlePidMemory` and `kill(pid, 0)`: correctness across relaunch (pid reuse), and the `frontmost` op's cost.
- Any `Task.sleep`/polling loops in `Settle.swift`: list each with its period and what it waits for.
- Swift tests: which of the above timings are covered with the injected clock, and which only on device.
