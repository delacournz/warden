# 12 · cli-e2e-setup

Auditor 12. Scope: `warden e2e` from start to the first spec process (`e2e.ts`, the `runSession`/`supervise` half of `batch.ts`, `lease-session.ts`, `batch/{setup,early-warm,warm-drivers}.ts`, `e2e/{bun-runner,jobs,launch,warm-connect}.ts`, `metro.ts`, `apps/example/warden.config.ts`). Commit `dfcc68b`. The owned tests pass: `bun test` over the 9 owned test files gives 227 pass, 0 fail.

## Top 5 by impact

- **12-2** Auto-gc is spawned right before the claim. Its idle pass can shut down the booted sim the claim has just reused, because gc never re-checks leases after its snapshot. This hits the first local run after 20 min idle, which is exactly the case the `idle` default creates.
- **12-1** The late-window hide in `supervise` can reboot a sim after the early warm-up already bound a `warden-simd` helper to it. It passes no `onShutDown`, and jobs are still given that helper's socket.
- **12-3** Three global barriers (setup, then open/hide, then `settleWarm`) mean the slowest device on any leg gates every job on every leg. A wedged helper (K7) costs up to 120 s and a slow `simctl launch` (K16) has no bound at all.
- **12-4** `slim` sits on the critical path behind the Metro await and after the installs. It needs only a booted device, so it could start at `onLeased`, and it could be skipped when the store already records the device as slimmed.
- **12-5** The Metro prewarm cannot be aborted. Ctrl-C, or a claim that fails, waits for the cold bundle to finish, up to 2 × 5 min.

## Findings

### 12-1 Late-window hide can reboot a sim under an already-warmed helper; jobs still get its socket
- Category: flake-risk
- Severity: P1
- Known?: new
- Evidence:
  - The early warm-up connects each device's `warden-simd` and takes a snapshot the moment the leg is leased (`apps/cli/src/commands/batch.ts:1628-1639@dfcc68b` → `apps/cli/src/batch/early-warm.ts:38-56@dfcc68b` → `apps/cli/src/batch/warm-drivers.ts:88-136@dfcc68b`). That is before `supervise` runs.
  - `supervise` then runs `hideLateWindows` (`batch.ts:1414-1417@dfcc68b`) for headless iOS runs where the claim booted something. It calls `hideSimWindows({ exec, sleep, warn }, live)` (`batch.ts:1326@dfcc68b`) with **no `onShutDown`**.
  - When closing a window shuts the sim down, `hideSimWindows` boots it again (`apps/cli/src/sim-windows.ts:276-287,303-323@dfcc68b`). `HideDeps.onShutDown` exists precisely because "whatever is bound to its old boot (a resident `warden-simd`) must go" (`sim-windows.ts:194-195@dfcc68b`, called at `:317`). The claim's own hide wires it to `stopHelperAfter` (`apps/cli/src/claim-flags.ts:142-148,188@dfcc68b`). The late hide does not.
  - Next, `settleWarm` copies every warm device's socket into `sockets` (`batch.ts:1158-1160@dfcc68b`) and each job gets `WARDEN_SIMD_SOCKET` (`batch.ts:668-669,705@dfcc68b`). The `HideOutcome.rebooted` list is thrown away, so a rebooted device keeps the socket of a helper (and in-sim bridge) bound to the previous boot.
  - Separately, the dev-client `simctl launch` in `openOnDevices` runs concurrently with the same hide (`batch.ts:1414-1417@dfcc68b`). A reboot in the middle of it loses that launch, which only warns.
  - `docs/plans/wdn-e2e.md:11` still states the invariant "warden starts helpers only **after** the hide step". The early warm-up (PERF-4.5) broke that invariant without the late hide being updated.
- Impact: estimated, needs a device. It happens only on headless iOS runs where the claim booted the sim and the late close shut it down. When it does, every flow on that device starts with a helper whose bridge belongs to a dead boot: the first driver call fails or falls back. The result is a red or slow device for the whole run, so P0-like for that run, but rare.
- Proposed fix: in `hideLateWindows`, pass `onShutDown: stopHelperAfter(ctx)` (or reuse `headlessDeps(ctx)`) and return the `HideOutcome`. For each udid in `rebooted`: delete its `sockets` entry (cold, safe), or re-run `warmDrivers` for that device before `settleWarm`. Files: `apps/cli/src/commands/batch.ts`. The call sits in my file; the reboot logic is agent 16's. Additive.
- Effort: S
- Risk: low. A rebooted device just starts cold. A real reboot needs a device to verify.
- How to verify: a batch test with a fake exec whose `simctl list` reports the sim `Shutdown` after the close. Assert that `stopHelper` is called for that udid and that the job env lacks `WARDEN_SIMD_SOCKET`, or carries a fresh one. On a device: `warden e2e example --headless` on two freshly created sims, then check `warm-<i>.log` against the `headless: closing … booting it again` warning.
- Confidence: med
- Verified by: traced the path from `startEarlyWarm` to `hideLateWindows`, `settleWarm` and `jobRunner` env

### 12-2 Auto-gc spawned just before the claim races the claim for idle booted sims
- Category: robustness
- Severity: P1
- Known?: new
- Evidence:
  - `runSession` calls `maybeAutoGc(ctx)` (`apps/cli/src/commands/batch.ts:1615@dfcc68b`), then claims at once (`:1646-1682`). `maybeAutoGc` spawns a detached `nice warden gc --quiet` whenever `store.gcWork` counts a device that went idle (unleased, `last_used_at` older than 20 min) since the last gc (`apps/cli/src/autogc.ts:47-66@dfcc68b`, `packages/core/src/store.ts:362-373@dfcc68b`).
  - Locally, a passing e2e leaves its sims booted (`e2e.ts:230-233@dfcc68b`, PERF-4.8). So the first `warden e2e` after a break of 20 min or more is exactly the case where gc is due and the claim wants to reuse those booted sims.
  - In the gc process: `leased` is snapshotted (`apps/cli/src/commands/gc.ts:130-141@dfcc68b`). `gcPlatform` reads `listDevices` immediately, then awaits `provider.inventory()` (a `simctl list`), then calls `provider.shutdown(id)` on every booted, unleased, idle record. The lease is never re-checked (`gc.ts:44-70@dfcc68b`). The iOS shutdown is a plain `simctl shutdown` (`packages/core/src/providers/ios.ts:312@dfcc68b`).
  - The claim's lease and `touchDevice` (`packages/core/src/claim.ts:347@dfcc68b`) land only after its own inventory (hundreds of ms). gc's `listDevices` runs about 50–150 ms after spawn. So the ordering "gc reads stale records → claim leases → gc shuts down the leased sim" is the likely one, not just a possible one.
- Impact: estimated. The reused sim goes down mid install or warm-up. Either the run fails (install or warm error, jobs on a dead device) or the next run pays a cold boot of 10–30 s (`docs/plans/wdn-perf.md:371`). It is a real race between two warden processes on one device, and it breaks the "never shut down what someone leased" rule.
- Proposed fix (two layers):
  - (a) My side: in `runSession`, call `maybeAutoGc` after `claimAll` has returned the leases (at the start of `supervise`). The device rows are then leased and touched before gc reads them. Additive.
  - (b) Agent 16's side: in `gcPlatform`, re-check `store.getLeaseFor(device)` inside a `store.transaction` right before each `provider.shutdown`, and skip a device that is now leased. Additive.
- Effort: S
- Risk: low. gc runs a little later. (b) needs no device to unit-test.
- How to verify: a unit test where a fake provider's `inventory` resolves only after a lease for the sim is inserted, asserting that `shutdown` is not called. On a device: leave the sims booted for more than 20 min after a passing `warden e2e example`, run it again, and grep `$WARDEN_HOME` logs and `simctl list` for a shutdown during the claim.
- Confidence: med
- Verified by: traced the path from `batch.ts:1615` through `autogc.ts` to `gc.ts:44-70`; read `store.gcWork`

### 12-3 Global readiness barriers: slowest device on any leg gates every job (warm 120 s, launch unbounded)
- Category: perf-latency
- Severity: P2
- Known?: known-extended K7
- Evidence:
  - In `supervise`, after the claim, every pool and every device pass three joins in series (`apps/cli/src/commands/batch.ts:1405-1418@dfcc68b`):
    - `preparePools` is a `Promise.all` over pools, each a `Promise.all` over devices (`:1224-1241`, `apps/cli/src/batch/setup.ts:58-86@dfcc68b`).
    - Then `Promise.all([openOnDevices(all live), hideLateWindows(all live)])` (`:1414-1417`).
    - Then `settleWarm`, which awaits every leg's warm-up (`early-warm.ts:57-64@dfcc68b`).
  - Only after that does `runGrid` start the pools (`:1431`).
  - The warm-up is warn-only, but its wait is bounded only by `WARM_TIMEOUT_MS` = 120 s (`apps/cli/src/batch/warm-drivers.ts:18@dfcc68b`). A wedged helper (K7) holds every device's first job for up to 120 s.
  - `openOnDevices` runs `ctx.exec(argv)` with no `timeoutMs` (`batch.ts:1075@dfcc68b`). A `simctl launch --terminate-running-process` that takes more than 30 s (K16, `docs/plans/wdn-e2e.md:467`) holds every device. The spec driver caps the same call at `LAUNCH_MS` 30 s; warden does not.
  - Pools are independent schedulers already (`runPools`, `batch.ts:1082-1107@dfcc68b`), so a leg has no reason to wait for another leg's setup.
- Critical path to the first job (traced; times estimated unless cited):
  - 2 sims warm (example, Release, slim, cache hit): claim reuse → `onLeased` (warm 182–185 ms resident, `docs/bench/ios-2026-10-16-perf.md:26`, overlaps install) → install join → slim (2 serial `simctl spawn`/device) → no hide (nothing booted) → `settleWarm` (already done) → `bun test` ×2. The serial warden work after the install is the slim alone.
  - 2 sims cold: the claim boots both, and `onLeased` fires once per leg, after the whole leg has booted and hidden (agent 16) → warm (cold 544–726 ms) ∥ install → slim cold (~74 spawns, 8 wide) → late hide (osascript, possibly a reboot, see 12-1) → `settleWarm` → jobs. Every step is gated by the slower sim.
  - 1 emulator with Metro: claim boot ∥ Metro start + prewarm (launched at port lease, `batch.ts:1657-1672`) → install → Metro await → `adb reverse` → jobs (no warm, no slim). A cold Metro bundle usually exceeds the install, so it is the critical path.
- Impact: estimated. Typical spread between devices is about 0.3–2 s per run (one device slims or launches slower). Under a helper wedge, up to 120 s per run on iOS. With legs, the slowest leg's whole setup is added to every other leg. Per test: that ÷ 8 for an 8-flow run.
- Proposed fix: run the post-claim steps per pool inside `runPools` (each pool: setup → open → hide → settle its own warm-up → `runBatch`). Within a pool, make the worker's first spawn await its own device's readiness (warm promise by udid) instead of a pool-wide `settleWarm`. Give `openOnDevices` `timeoutMs` (30 s, as `LAUNCH_MS`). Files: `apps/cli/src/commands/batch.ts`, `apps/cli/src/batch/early-warm.ts` (a `settledFor(udid)`). Additive.
- Effort: M
- Risk: med. The grid's first frame and the setup error path ("setup failed on every device") must keep working per pool. Tests can cover it with fakes; the gain needs a device to measure.
- How to verify: a batch test with two legs where leg B's `warmConnect` never resolves. Assert that leg A's first job spawns before the 120 s timer fires. On a device: compare `startedAt` (`batch.json`) minus the claim end, before and after, on `warden e2e example --count 2` with one fresh and one booted sim.
- Confidence: high
- Verified by: read `supervise`, `startEarlyWarm`, `warmDrivers`, `runPools`

### 12-4 `slim` waits behind the Metro await and the installs although it only needs a booted sim
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `supervise` awaits `startServices` (Metro, serve, recordings) before `preparePools` (`apps/cli/src/commands/batch.ts:1402-1405@dfcc68b`). The slim inside `prepareDevices` (`:883-887`, `apps/cli/src/batch/setup.ts:45-53@dfcc68b`) therefore starts only after the install join (`lease-session.ts:400@dfcc68b`) and after Metro (with its prewarm) is up.
  - The slim depends on neither. `slimSimulator` is a `launchctl print-disabled` + `list`, then `disable`/`bootout` per label, 8 wide (`packages/core/src/sims/slim.ts:178-210@dfcc68b`).
  - The `setup` command does need `WARDEN_METRO_URL` (the env from `startServices`), so only the slim half can move.
  - `apps/example/warden.config.ts:100,109` sets `slim: true` on both suites, so every example run pays it. A device the store records as slimmed (`setSlimmed`, `batch.ts:886`) still pays the two serial `simctl spawn` probes on every run. The disable persists across the device's reboots (`slim.ts:170-177`), and a plain claim clears the record when it restores (`apps/cli/src/commands/claim.ts:40-43@dfcc68b`).
- Impact: estimated. On a slimmed sim, 2 serial `simctl spawn` at about 100–200 ms each gives roughly 0.2–0.4 s per run on the critical path. On a fresh sim, about 74 spawns / 8 wide gives roughly 10 rounds × 150 ms ≈ 1.5 s per run (iOS). For example-dev, the whole slim hides behind a cold bundle instead of following it. Per 8-test rep: 0.2–1.5 s.
- Proposed fix: start the slim in `onLeased` per device (next to the early warm-up, `batch.ts:1649-1655`) as a promise that `prepareDevices` awaits before running `command`. Skip the probes when `slimmedAt` is set and newer than the device's last boot (or keep a denylist hash in the record). Files: `apps/cli/src/commands/batch.ts`, `apps/cli/src/batch/setup.ts`. Additive.
- Effort: S
- Risk: med. Slim then runs concurrently with `simctl install` and the helper warm-up on the same sim. `installd`, AX and the bridge are in `NEVER_DISABLE` (`slim.ts:62-85`), but `appstored` is disabled. This needs an on-device check that the installs and the first snapshot are unaffected.
- How to verify: a batch test asserting that `slim:<udid>` precedes the `ensure` resolution in `h.events`. On a device: time `warden e2e example --all` from the claim's `✔` to the first `job:` log, before and after.
- Confidence: high (mechanism), med (gain)
- Verified by: read `supervise`, `setupDevices`, `slimSimulator`

### 12-5 Metro prewarm is not abortable: Ctrl-C or a failed claim waits for the cold bundle
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `launchRunMetro.run` awaits `deps.prewarm(url, platform)` without a signal (`apps/cli/src/commands/batch.ts:1016-1019@dfcc68b`).
  - `prewarmMetro` makes two sequential `fetch`es, each with only `AbortSignal.timeout(5 min)` (`apps/cli/src/metro.ts:47,257-279@dfcc68b`).
  - `launch.stop()` sets `cancelled` and then `await launch.pending` (`batch.ts:983-989@dfcc68b`). `cancelled` is read only by `startMetro`'s readiness poll, not by the prewarm.
  - So the SIGINT handler during the claim (`batch.ts:1640-1645`), the claim-failure path (`await launch?.stop()`, `:1694`), and `awaitRunMetro` after a SIGINT in `supervise` (`:1175`) all block until the bundle finishes or 10 min pass. Meanwhile the process ignores SIGINT, because a handler is installed.
  - The harness's `prewarm` resolves at once (`apps/cli/src/commands/batch.testing.ts:199-204@dfcc68b`), so the SIGINT tests (`e2e.test.ts:460-486`) cannot see this.
- Impact: estimated. Ctrl-C or a failed claim on a Metro suite (example-dev, iOS and Android) takes as long as the rest of the cold bundle: tens of seconds for the example app, 10 min at worst. A claim that fails at once (no free device) is also reported only after the bundle.
- Proposed fix: give `prewarm` an `AbortSignal` (`BatchDeps.prewarm(url, platform, signal)`), built from `AbortSignal.any([controller.signal, cancelSignal])` in `launchRunMetro`. `stop()` aborts it and kills Metro without waiting. Files: `apps/cli/src/metro.ts`, `apps/cli/src/commands/batch.ts`, `batch.testing.ts` (a `prewarm: "hang"` mode). It changes the `BatchDeps` type (internal), so additive.
- Effort: S
- Risk: low
- How to verify: a harness `prewarm` that never resolves unless aborted. Send SIGINT during the claim and assert exit 130 and that `metro:SIGTERM` happens without the prewarm settling. On a host: `warden e2e example-dev --all`, then Ctrl-C while the spinner says "building the ios bundle".
- Confidence: high
- Verified by: read `launchRunMetro`, `prewarmMetro`, `runSession`; checked the harness

### 12-6 iOS `openOnDevices`: unbounded `simctl launch` on the critical path, then the spec relaunches anyway
- Category: perf-latency
- Severity: P2
- Known?: known-extended K16
- Evidence:
  - With `metro.open` (default `true`, `packages/core/src/affected/affected.schema.ts:94@dfcc68b`), `openOnDevices` runs `xcrun simctl launch --terminate-running-process <udid> <bundle> --initialUrl <metro> …` per device (`apps/cli/src/metro.ts:290-305@dfcc68b`, `apps/cli/src/commands/batch.ts:1057-1079@dfcc68b`). It uses no `timeoutMs` (`:1075`) and is awaited before the warm settle and the first job (`:1414-1418`).
  - Every spec `app.open()` then launches again with `relaunch: true` and the same `--initialUrl` (`packages/e2e/src/app.ts:72-75@dfcc68b`, `apps/cli/src/e2e/launch.ts:39-42@dfcc68b`). So for specs that call `app.open()`, which is every flow of the example per `warden.config.ts:22`, warden's launch is killed within about one `bun test` start of being made. Its only effect is a device-side bundle load that gets thrown away.
  - PERF-4.5 skipped `openOnDevices` for Release builds (`docs/plans/wdn-perf.md:350`). That landed implicitly: no `metro` means no open (`batch.ts:1415`). The dev-client case still pays it.
  - K16 (`docs/plans/wdn-e2e.md:467`): a launch once took more than 30 s. Here nothing would kill it.
- Impact: estimated. One `simctl launch` per device (about 0.5–1.5 s) on the critical path per run, plus a discarded bundle load on device CPU, for Metro suites on iOS. Worst case unbounded (K16, more than 30 s).
- Proposed fix: always pass `timeoutMs: 30_000` (as `LAUNCH_MS`). Then either default `metro.open` to `false` for spec suites (e2e always runs specs), or launch without awaiting (fire, warn on failure) so the first job does not wait. Files: `apps/cli/src/commands/batch.ts`; the schema default is `packages/core/src/affected/affected.schema.ts`. The timeout is additive; the default flip is a `policy_change`, because specs that never call `app.open()` rely on it.
- Effort: S
- Risk: med. A spec that assumes the app is already open would break with `open: false`. Measuring it needs a device.
- How to verify: on a device, `warden e2e example-dev --all` with `metro.open: false` against the default. Compare the first flow's duration and the whole run (`batch.json`).
- Confidence: med
- Verified by: read `openOnDevices`, `devClientLaunchArgv`, `app.ts` launch

### 12-7 Android: a failed `adb reverse` only warns, and the device then runs every flow against an unreachable Metro
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - On Android, `openOnDevices` runs `adb -s <serial> reverse tcp:P tcp:P` (`apps/cli/src/metro.ts:308-310@dfcc68b`). A non-zero exit only calls `warn` (`apps/cli/src/commands/batch.ts:1076@dfcc68b`), and the device stays in `live`.
  - Its jobs then launch the dev client with `--initialUrl http://127.0.0.1:P` (`apps/cli/src/e2e/launch.ts:39-42`), which cannot reach the host. Each test fails only on its own timeouts.
  - Contrast the setup failure, which drops the device (`batch.ts:899@dfcc68b`).
- Impact: estimated. On Android Metro suites, when `adb reverse` fails (e.g. adbd restarting just after boot), every flow on that device burns up to the action/test timeouts (30 s / 2 min, `config.defaults.ts:22-23`) and is reported as an app failure rather than a setup one.
- Proposed fix: retry `adb reverse` once after `adb wait-for-device`. If it still fails, drop the device as a failed setup (reuse the `DeviceSetup` outcome) or fail the run with the exec error. Files: `apps/cli/src/commands/batch.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: a batch test with a fake exec returning exit 1 for `adb reverse`. Assert that the device gets no job and the report names it. On a device: kill adbd mid-claim (`adb kill-server`) on `warden e2e example-dev --platform android`.
- Confidence: med
- Verified by: read

### 12-8 `slim: true` makes `--platform android` refuse the whole suite (K10)
- Category: dx
- Severity: P2
- Known?: known-confirmed K10
- Evidence:
  - `platformError` returns "slim is iOS-only" for any non-iOS platform (`apps/cli/src/commands/e2e.ts:123-125@dfcc68b`), checked in `preparedRun` (`:359-360`).
  - Both example suites set `slim: true` with `platform: "ios"` (`apps/example/warden.config.ts:35,100,109`). So `warden e2e example --platform android` cannot run, and the plan's Android acceptance had to fall back to `bun test` by hand (`docs/plans/wdn-perf.md:592,686`).
  - The schema's own refusal only fires when the suite's platform is `android` (`affected.schema.ts:221-222`).
- Impact: n/a. It blocks the warden e2e path for the example suite on Android entirely (Android).
- Proposed fix: `deviceSetup(suite, platform)` drops `slim` off iOS and adds a one-line note. Remove the `platformError` slim case. Files: `apps/cli/src/commands/e2e.ts` (+ test). Additive (a refusal becomes a run).
- Effort: S
- Risk: low
- How to verify: update the existing `platformError` test to assert a run with a note and no `slim:` events.
- Confidence: high
- Verified by: read

### 12-9 Static round-robin shards: one device can idle while the other still has flows (K5)
- Category: perf-latency
- Severity: P2
- Known?: known-confirmed K5
- Evidence:
  - `shardFlows` sorts by id and deals flow `i` to shard `i % n` (`apps/cli/src/e2e/bun-runner.ts:70-78@dfcc68b`).
  - `jobPlan` turns each share into one `bun test` argv up front (`apps/cli/src/e2e/jobs.ts:25-43@dfcc68b`), so a device that finishes early cannot take work from the other.
  - Example with 6 flows on 2 sims: shard-0 = devtools, settings, todo-detail and shard-1 = onboarding, sign-in, todos. The split ignores duration.
  - Retries rerun only the failed flows on the same worker (`jobs.ts:76-102`), which adds tail imbalance.
  - The job timeout is multiplied by the biggest shard (`e2e.ts:555@dfcc68b`): 3 × 10 min = 30 min for `example`, 3 × 15 min = 45 min for `example-dev` (`warden.config.ts:108`).
- Impact: not measurable here (no per-flow durations in the bench docs). It equals the duration difference between the two shards per run.
- Proposed fix: as the plan says (`docs/plans/wdn-perf.md:684`), use LPT (longest processing time first) assignment from the previous run's `results.jsonl` durations under `$WARDEN_HOME/batches/*/e2e`, falling back to round-robin. Files: `apps/cli/src/e2e/bun-runner.ts`, `apps/cli/src/e2e/jobs.ts`. Additive.
- Effort: M
- Risk: low (a deterministic fallback stays)
- How to verify: a `jobPlan` unit test with given durations. On a device: per-device busy time in `batch.json`.
- Confidence: high
- Verified by: read

### 12-10 A CLI `--passes N` bypasses the isolation rule: whole shards rerun, and passes share one out dir
- Category: correctness
- Severity: P3
- Known?: known-extended K14
- Evidence:
  - `suiteOpts` lets a CLI `--passes` override the suite's (`apps/cli/src/commands/e2e.ts:96,109-110@dfcc68b`). But isolation is chosen from `suiteIsolation(config)` (`:442`), i.e. from the config's `passes`, and the schema's "passes > 1 needs isolate flow" rule only checks the config (`affected.schema.ts:66-69`).
  - So `warden e2e example --passes 2` runs device isolation. `jobRunner` respawns the whole shard per pass (`batch.ts:754-760@dfcc68b`) with the same `seq`, so the same `WARDEN_E2E_OUT` (`apps/cli/src/e2e/jobs.ts:46-47@dfcc68b`, `e2e.ts:394`). `results.jsonl` is append-only (`packages/e2e/src/runner/results.ts:52`), so the report lists each test once per pass.
  - The per-flow case shares the out dir across passes as well (the same mechanism as K14's per-attempt ring).
  - There is no test for a CLI `--passes`; only suite `passes` is covered (`e2e.test.ts:149,1174`).
- Impact: n/a. It is wrong semantics: N× the run time for all flows in a shard, and duplicated tests in `e2e-report.json`.
- Proposed fix: compute isolation from the merged `passes` (`suiteIsolation({ ...config, passes: Number(merged.passes) })`), and refuse `--passes > 1` with an explicit `isolate: "device"`. Include `pass` in `attemptOut` (`<worker>-<seq>[-p<k>]`). Files: `apps/cli/src/commands/e2e.ts`, `apps/cli/src/e2e/jobs.ts`; agent 13's verdict reader must follow the new path. Changes the out-dir layout (`contract: additive` for the isolation part).
- Effort: S
- Risk: low
- How to verify: an e2e test where `setup(["--all", "--passes", "2"])` expects flow jobs (`jobNames` = per-flow ×2) and distinct `WARDEN_E2E_OUT` per pass.
- Confidence: high
- Verified by: read; traced the path from `suiteOpts` to `jobRunner`

### 12-11 Teardown runs its 15 s graces in series before the report; a second Ctrl-C does not escalate
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - `teardown` runs `stopServe` (≤ 15 s + SIGKILL), then the recordings, then the helpers, then `metro.stop` (≤ 15 s + SIGKILL), each awaited in turn (`apps/cli/src/commands/batch.ts:1382-1399,219,328-335@dfcc68b`; `apps/cli/src/metro.ts:45,146-153@dfcc68b`). All of this happens before `batch.json`, the verdict and the release (`batch.ts:1439-1443`).
  - Helper `close` only disconnects (`apps/cli/src/e2e/warm-connect.ts:33-36`) and Metro does not depend on serve, so only serve → recordings is an ordering contract.
  - SIGINT in `supervise` only forwards the same signal to the jobs (`batch.ts:1372-1375`). Because a handler is installed the process never exits on Ctrl-C, and a second Ctrl-C does nothing new. A job that ignores SIGINT is killed only by its watchdog: `jobTimeoutMs × biggest shard`, i.e. 30–45 min for the example suites.
- Impact: estimated. Typically under 1 s (Metro and serve exit on SIGTERM). Worst case 30 s (serve + Metro graces) before the verdict, and a Ctrl-C that cannot be forced.
- Proposed fix: run `helpers.close` and `metro.stop` concurrently with serve → recordings. On the second SIGINT, SIGKILL the job groups and the services. Files: `apps/cli/src/commands/batch.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: a harness where `serveExitsOnKill: false`, asserting that `metro:SIGTERM` is sent before the serve grace ends. A second `h.signals.get("SIGINT")()` should yield `SIGKILL` on the jobs.
- Confidence: high
- Verified by: read

### 12-12 One leg's failed claim does not stop the other legs' installs; the failure is reported only after them
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence:
  - `runLegs` is a `Promise.all` over `runLeg` (`apps/cli/src/lease-session.ts:364-374@dfcc68b`). Each `runLeg` checks `args.aborted` before its install (`:348`), but a sibling leg's claim failure is not part of `aborted` (`batch.ts:1674` is SIGINT or a failed Metro).
  - `claimAll` reports the claim failure only after every leg settles (`lease-session.ts:400-411`), so the failure waits for the other legs' installs, which can include a local build.
- Impact: estimated. On multi-leg suites only (the example has none), a failing leg delays the error by the other legs' install/build time (seconds to minutes).
- Proposed fix: share an internal `AbortController` in `runLegs` that is set when any leg's claim fails, and include it in the install guard. Files: `apps/cli/src/lease-session.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: a lease-session test with two legs, where leg 1's claim fails and leg 0's `ensure` is pending. Assert that `ensure` is never called for leg 0 if it had not started.
- Confidence: high
- Verified by: read

### 12-13 `--dry-run` reports `ok: true` for a run that would be refused
- Category: correctness
- Severity: P3
- Known?: new
- Evidence:
  - `e2e()` returns from the `flows.length === 0 || opts.dryRun` branch (`apps/cli/src/commands/e2e.ts:288-299@dfcc68b`) before `preparedRun` (`:300`). So `platformError` (slim on Android), `specPlan` (no bun, no preload, no bundle id) and `runPlan` (bad `--devices`, bad durations) are never checked.
  - Example: `warden e2e example --platform android --dry-run` exits 0 with `ok: true`.
- Impact: n/a. A CI pre-check with `--dry-run` passes a config that the real run refuses.
- Proposed fix: run `preparedRun` (it leases nothing) before the dry-run return, and report its error. Files: `apps/cli/src/commands/e2e.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: an e2e test running `--dry-run --platform android` on a slim suite and expecting exit 1.
- Confidence: high
- Verified by: read

### 12-14 `apps/example/warden.config.ts` says `example` runs one spec process per flow; it runs one per device
- Category: dx
- Severity: P3
- Known?: new
- Evidence:
  - The doc comment says "`example`: the Release build, one spec process per flow" (`apps/example/warden.config.ts:63@dfcc68b`).
  - The suite sets neither `isolate` nor `passes`, so `suiteIsolation` gives `device` (`packages/core/src/affected/affected.schema.ts:53-55@dfcc68b`; PERF-4.7, `docs/plans/wdn-perf.md:366,699`).
  - Readers comparing per-flow logs or timings will be misled.
- Impact: n/a
- Proposed fix: update the comment (or set `isolate: "flow"` if per-flow really is intended for the Release suite). Files: `apps/example/warden.config.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: `warden e2e example --dry-run --json` shows `isolate: "device"`.
- Confidence: high
- Verified by: read

## Known items

- **K5**: known-confirmed (12-9). Static round-robin by sorted id is still in `bun-runner.ts:70-78`.
- **K7**: known-extended (12-3). Besides the per-launch cost, a wedged helper holds every device's first job via the global `settleWarm` barrier for up to `WARM_TIMEOUT_MS` 120 s.
- **K10**: known-confirmed (12-8). `platformError` (`e2e.ts:123-125`) refuses, and both example suites are `slim`.
- **K14**: known-extended (12-10). Passes of one attempt also share `WARDEN_E2E_OUT` (same `seq`), so `results.jsonl` accumulates across passes as well as attempts.
- **K16**: known-extended (12-6, 12-3). Warden's own `openOnDevices` launch has no timeout at all, where the spec driver has 30 s, and it gates every job.
- PERF-4.5 claims (`docs/plans/wdn-perf.md:350-353`) verified as landed:
  - early warm at `onLeased`: `batch.ts:1628-1655`;
  - hide ∥ open: `batch.ts:1414`;
  - no open without Metro: `batch.ts:1415`;
  - legs `Promise.all`: `lease-session.ts:371`;
  - `READY_POLL_MS` 150: `metro.ts:44`;
  - direct `node_modules/.bin/expo`: `metro.ts:58-73`, only when `node` is on PATH.
- PERF-4.7 landed (device isolation by default, `affected.schema.ts:53-55`) and PERF-4.8 landed (`e2e.ts:230-233`).
- Metro readiness: Expo's `/status` sets `X-React-Native-Project-Root` before waiting on the bundler (`node_modules/@expo/cli/build/src/start/server/metro/dev-server/createMetroMiddleware.js:86`). So the 2 `lsof` fallback spawns per poll do not happen with Expo, and the pending `/status` acts as a long-poll. No finding.

## Gaps I could not assess here

- 12-1: how often a late window close actually shuts a claimed sim down. Run `warden e2e example --headless --all` on 2 freshly created sims (`warden sim create` … then claim), and grep stderr for `headless: closing … booting it again`. Then check the first flow's `trace.jsonl` for a helper reconnect.
- 12-2: the real gc-vs-claim timing. After a passing `warden e2e example`, wait 21 min, run it again with `WARDEN_AUTO_GC` unset, and watch `xcrun simctl list devices | grep Booted` once a second during the claim.
- 12-4: whether slimming concurrently with `simctl install` and the first warm snapshot is safe. Start `warden sim slim <udid>` and `xcrun simctl install <udid> <app>` together, then `warden ui snapshot -i`.
- 12-6: what the extra dev-client launch costs. Run `warden e2e example-dev --all` with `metro.open: true` vs `false`, 3 runs each, and compare the first flow's duration and the time from the claim end to the first job.
- Per-phase supervisor timings do not exist in the bench docs: the bench drives the suite outside `warden e2e`. Add stamped phase lines (claim end, Metro up, setup end, open end, warm settled, first spawn) to `batch.json`, then re-run `warden e2e example --all --count 2` cold and warm.

## Owned files not read

- `apps/cli/src/commands/e2e.test.ts` and `batch.test.ts`: grepped only, as instructed.
- `lease-session.test.ts`, `metro.test.ts`, `early-warm.test.ts`, `warm-drivers.test.ts`, `bun-runner.test.ts`, `jobs.test.ts`, `launch.test.ts`: run (all pass), not read line by line.

## Questions for the user

- With `metro.open` (default `true`), should warden still launch the dev client before the first job, now that every spec's `app.open()` relaunches it? Dropping it is 12-6's main saving, but it breaks specs that assume the app is already open.

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-12.md, docs/audit/ASSIGN-16.md (ownership)
- apps/cli/src/commands/e2e.ts, apps/cli/src/commands/batch.ts (1–380, 495–1856), apps/cli/src/commands/batch.testing.ts
- apps/cli/src/lease-session.ts, apps/cli/src/metro.ts, apps/example/warden.config.ts
- apps/cli/src/batch/setup.ts, early-warm.ts, warm-drivers.ts
- apps/cli/src/e2e/bun-runner.ts, jobs.ts, launch.ts, warm-connect.ts, verdicts.ts (`judgeJob`)
- Context:
  - apps/cli/src/claim-flags.ts (115–200), apps/cli/src/sim-windows.ts (169–323), apps/cli/src/autogc.ts, apps/cli/src/commands/gc.ts (27–150), apps/cli/src/agent-ui/stop-helper-after.ts
  - packages/core/src/sims/slim.ts, packages/core/src/affected/affected.schema.ts (parts), packages/core/src/config.defaults.ts, packages/core/src/liveness.ts, packages/core/src/store.ts (gcWork), packages/core/src/batch/schedule.ts (grep), packages/e2e/src/app.ts (60–90), node_modules/@expo/cli/…/createMetroMiddleware.js (grep)
  - docs/plans/wdn-perf.md (330–375, 676–700), docs/plans/wdn-e2e.md (grep), docs/bench/ios-2026-10-16-perf.md (grep)
  - test greps in apps/cli/src/commands/e2e.test.ts, batch.test.ts, startup.test.ts
