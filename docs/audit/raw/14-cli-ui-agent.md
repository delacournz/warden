# 14 · cli-ui-agent: `warden ui <sub>` per-call cost and the iOS helper lifecycle

Commit read: `dfcc68b` (HEAD of the audit branch). Line numbers are from the files as they are now.

## Top 5 by impact

- 14-1: when `ensureHelper` gives up at 5 s it leaves its spawned helper running. On the warm path that means the run goes "cold" and every job spawns a stdio helper next to the late resident one, so two quiescence streams run on one sim and each settle takes ~2.5 s instead of ~260 ms.
- 14-2: a helper that accepts the connection but sends no `ready` within 2 s is taken for silence. A second helper is spawned on the same sim, and the first is never stopped (its record is overwritten).
- 14-3: `stopHelper` has no arbitration. A stop that races an `ensureHelper` unlinks the new helper's socket and drops its record, which leaves an orphan and leads to a third spawn.
- 14-8 (K17 extended): Android `warden ui` pays per call for an adb shell, a boot/screen probe, 6 `settings` calls to turn animations off, a dex check, a `warden-uiad` start, and then a stop plus 3 `settings put` to restore animations. Animations are back on between calls.
- 14-5: helper reuse across runs is defeated whenever the owner key changes (`user:<ppid>` from `bun run` or scripts, CI run ids). Each such run pays a full stop plus cold spawn, which goes against the PERF-1.5 acceptance.

## Findings

### 14-1 Spawn deadline abandons a live, still-starting helper; the warm path then runs cold and collides with it
- Category: flake-risk
- Severity: P1
- Known?: new
- Evidence:
  - `apps/cli/src/agent-ui/helper.ts:29@dfcc68b`: `SPAWN_WAIT_MS = 5000` is the budget for the whole call, measured from `started` (`:497`).
  - `helper.ts:456@dfcc68b`: the spawner awaits the ready line for up to `SIGNAL_WAIT_MS` 1500 ms (`:42`). It then polls (`:474` WAIT while `pidAlive(spawned.pid)`) until `:504-506`, which returns `engine_unavailable` "did not answer … within 5000 ms" even though its own child is alive and still starting.
  - `helper.ts:509-514@dfcc68b`: the `finally` only detaches the stdout reader and releases the row. The detached child (`spawnDetached` `:159-168`, `detached: true`, `unref`) is never killed. Its `state.json` record was already written (`:393`).
  - Warm path: `apps/cli/src/e2e/warm-connect.ts:16-17@dfcc68b` turns that failure into `err(...)`. `apps/cli/src/batch/warm-drivers.ts:120-122@dfcc68b` warns "continuing cold". `apps/cli/src/commands/batch.ts:668-669@dfcc68b` gives jobs no `WARDEN_SIMD_SOCKET`. `packages/e2e/src/driver/ios/ios-driver.ts:502-515@dfcc68b` then spawns a stdio `warden-simd` per job.
  - The late resident helper opens its quiescence stream at start and keeps it for its life (`packages/e2e/AGENTS.md:63-65`). Two streams on one sim make `settle` fall back to `via:"snapshot"`, ~2.5 s instead of ~260 ms, "for as long as the other stream is open" (`packages/e2e/AGENTS.md:65`). The orphan only goes away at its 10 min idle exit (`helper.ts:39`).
  - Slow starts are expected on this path. The warm-up runs "in parallel with the app install, Metro and the per-device setup" (`apps/cli/src/batch/early-warm.ts:17-19@dfcc68b`). The measured `helperColdToSnapshot` was p50 3593 / p95 6379 ms on a loaded host (`docs/plans/wdn-e2e.md:334`).
  - Waiters (non-holders) hit the same 5 s wall while a live spawn row says someone is still starting (`helper.ts:434,443,504`).
- Impact: estimated. Once it triggers, each settle costs +2.2 s (2.5 − 0.26 s, measured in `packages/e2e/AGENTS.md:65`). At ~2 settles per test, ~4.5 s/test, or ~35 s per 8-test rep on that device. A `warden ui` caller just gets a spurious exit 3. iOS only.
- Proposed fix (`helper.ts`): (a) a spawner whose own child is still alive keeps waiting up to a larger cap, for example `ROW_STALE_MS` 15 s, and so do waiters while the row is live; (b) on final failure, `stopHelper` the child it spawned (SIGTERM its pid, unlink the socket, forget the record) before returning. The change is additive; the timeout users see grows, so `policy_change`.
- Effort: S
- Risk: med. A truly broken helper now fails after 15 s instead of 5 s. Confirming the collision needs a device.
- How to verify: in a unit test with `listenAfterMs = 7000`, expect success. With "never listens", expect `kill(pid)` and the record forgotten. On device: load the host, run `warden e2e` on a just-booted sim, and check `warm-*.log` and that `ps` shows one `warden-simd --udid` per sim.
- Confidence: high on the mechanism, med on how often it fires.
- Verified by: traced path from `warmConnect` → `ensureHelper` deadline → batch `socketEnv` → `openIosDriver` stdio spawn.

### 14-2 A helper slow to answer `ready` (2 s) is treated as absent: a second helper is spawned beside it
- Category: robustness
- Severity: P1
- Known?: new (corrects the prior read)
- Evidence:
  - `helper.ts:157-158@dfcc68b`: the default `connect` is `connectSimd({ readyTimeoutMs: 2000 })`. `simd-client.ts:236-253@dfcc68b` gives E_TIMEOUT when the handshake has not finished in time.
  - `helper.ts:470-473@dfcc68b`: any connect failure with no spawn yet goes to `onSilence`. `:443-451` takes the row and connects again, which can cost another 2 s. Then `spawnHelper` unlinks the live helper's socket path (`:383`), spawns a new process (`:384`) and overwrites the record with the new pid (`:393`).
  - The old helper keeps running with its unlinked listening socket and its quiescence stream. Nothing stops it, and its pid is no longer recorded, so `ui close` and `stopHelper` cannot SIGTERM it (`:580` uses `record.pid`).
  - Correction to the prior read: a cold device (no socket file) does not lose 2 s. `Bun.connect({unix})` rejects at once with ENOENT/ECONNREFUSED (`packages/e2e/src/driver/ios/simd-transport.ts:166@dfcc68b`), so the 2 s only bites a socket that accepts but is slow to answer `ready`.
- Impact: estimated. Up to 4 s lost on the call (two 2 s handshakes), then two helpers on the sim: +2.2 s per settle (as in 14-1) for up to 10 min. Under load (load average 190-360 in `wdn-e2e.md:330`) a 2 s per-connection `ready` miss is plausible but not measured. iOS.
- Proposed fix (`helper.ts`): tell the failure kinds apart. ENOENT or refused means silence. A timeout while the socket exists and the recorded pid is alive means "busy": WAIT, or, when holding the row, `stopHelper` the recorded pid before spawning. `spawnHelper` should refuse to spawn while `readState().helper.pid` is alive unless it was stopped. Consider `readyTimeoutMs` 5 s for the probe. Additive.
- Effort: S
- Risk: low. Needs a device or a hung fake to see the slow-ready case.
- How to verify: a unit test where the fake `connect` returns E_TIMEOUT while `pidAlive(recorded)` is true should expect no second `spawnDetached`. An integration test can use a `fake-simd` script that delays `ready` by 3 s.
- Confidence: med
- Verified by: read `helper.ts`, `simd-client.ts`, `simd-transport.ts`

### 14-3 `stopHelper` is unarbitrated: a stop racing a spawn deletes the new helper's socket and record
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - `helper.ts:556-589@dfcc68b`: `stopHelper` reads `record` once (`:563-564`), and its `gone` test is `!existsSync(socket) || !pidAlive(record.pid)` on the old pid (`:571`). It then unconditionally `unlinkQuietly(socketPath)` (`:583`) and `forgetHelper(readState(...))` (`:584`), whatever helper is recorded or listening by then.
  - Nothing takes the `simd_spawn:<udid>` row: only `ensureHelper` uses `claimSpawnRow` (`:253-267`).
  - Callers that run concurrently with `warden ui` / warm: `releaseDevices` deletes the lease first and runs `after` afterwards (`apps/cli/src/device-lease.ts:119-142@dfcc68b`). That covers gc of a stale lease, `release --shutdown` and `ui close --release` (`close.ts:43`), and plain `ui close` (`close.ts:46`). Once the lease is gone, another owner can claim and call `warden ui`. `ensureHelper` sees silence (or a stale owner, `:430-438`), spawns, and its new socket appears at the same path. The stopper's `gone()` is already true (old pid dead), so it unlinks the new socket and drops the new record.
  - The same happens with one agent making parallel tool calls (`ui close` ‖ `ui snapshot`).
- Impact: estimated. The next call finds no socket and spawns a third helper while the orphan with a client-less stream lives up to 10 min, so +2.2 s per settle (as in 14-1), and the orphan cannot be stopped by `ui close` (no record). iOS.
- Proposed fix (`helper.ts`): `stopHelper` claims the spawn row (waits briefly if held). It remembers the socket's inode at start and unlinks only if `stat(socket).ino` is unchanged. It forgets the record only if `readState().helper?.pid === record.pid`. Additive.
- Effort: S
- Risk: low. A unit test covers it; no device needed.
- How to verify: a unit test with fake deps where `ensureHelper` runs during `stopHelper`'s wait. Assert that the new record survives and the socket is not unlinked. An integration variant can use `helper.race-fixture.ts`.
- Confidence: high on the mechanism, med on frequency.
- Verified by: read `helper.ts`, `device-lease.ts`, `close.ts`, `stop-helper-after.ts`

### 14-4 Signals sent to recorded pids without an identity check (pid reuse): SIGTERM/SIGINT/SIGKILL can hit an unrelated process
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `helper.ts:566@dfcc68b`: `running` is true when the socket file exists or `pidAlive(record.pid)`. A helper that crashed leaves its socket file behind.
  - `:571`: `gone` stays false while the (reused) pid is alive.
  - `:578-581`: after ≤ 2 s, `kill(record.pid, "SIGTERM")` with no check that the pid is still `warden-simd --udid <udid>`.
  - `video.ts:116,124-131@dfcc68b`: `video stop` sends SIGINT to `state.video.pid`, waits 5 s, then sends SIGKILL, also with no identity check. A recorder that already ended (for example a sim shutdown) leaves a stale pid.
  - `helperStatus` (`:600-608`) reports a reused pid as `running`.
  - `state.json` records persist indefinitely; `sweepDeadHelpers` runs only from gc and only for dead pids (`:615-629`).
  - This conflicts with the repo rule "foreign = read-only" (`AGENTS.md`, Key Patterns).
- Impact: a rare but destructive wrong-process kill. No time saving.
- Proposed fix: record the process start time with the pid (`ps -o lstart= -p`, or `kill(pid,0)` plus `ps -o command=` containing `warden-simd --udid <udid>` / `recordVideo`). Signal only on a match, or only when the socket handshake answered (`attached.success`). Files: `helper.ts`, `video.ts`, `state.ts` (record field, additive).
- Effort: S
- Risk: low
- How to verify: a unit test with `pidAlive` true, connect failing and an identity check returning "other" should expect no `kill`.
- Confidence: high
- Verified by: read

### 14-5 Resident helper replaced on every run when the owner key churns (`user:<ppid>`, CI run id) or the helper path resolves differently
- Category: perf-latency
- Severity: P2
- Known?: new (gap in PERF-1.5's accept "back-to-back `warden e2e` runs reuse the helper", `docs/plans/wdn-perf.md:226`)
- Evidence:
  - `helper.ts:333-344@dfcc68b`: the helper is replaced when `leaseOwnerKey !== record.owner`.
  - `ownerKey` for users is `user:${owner.pid}` (`:227-228`), and that pid is the CLI's `ppid` (`packages/core/src/owner.ts:39@dfcc68b`). `bun run e2e`, Makefiles and any script get a new shell pid per run. CI uses `GITHUB_RUN_ID` (`owner.ts:32-33`), which also changes per run (self-hosted macOS runners keep sims).
  - The binary check compares `located.data !== record.binary.path` (`:351`). `locateHelperBinary` resolves from the caller's `WARDEN_SIMD` / `WARDEN_HELPER_DIR` (`:320`), so a `warden ui` from a shell with a different env (same owner, for example an agent poking its own background `warden e2e`) replaces the helper the run's jobs are connected to, mid-run.
- Impact: estimated. Per affected run: `stopHelper` (shutdown, ≤ 2 s) plus a cold spawn and first snapshot, p50 958.9-3593.1 ms (`docs/plans/wdn-e2e.md:334`), so ~1-4 s per run per device. Mid-run replacement: the jobs' clients see `E_HELPER_CRASHED` and reconnect (or spawn stdio, `ios-driver.ts:502-515`). iOS.
- Proposed fix: key replacement on what the helper actually inherits, a hash of the `WARDEN_SIMD_*` env plus the binary's realpath and mtime, rather than on the owner's identity. Alternatively, for `user` owners compare `repo/worktree/tty`. Never replace while the current lease holder is the one that spawned it within this run. Files: `helper.ts`, `state.ts`. `policy_change` (it changes when a helper is replaced).
- Effort: M
- Risk: med. A stale env could survive into a new owner's session, which is the reason for the current rule. Verify on device.
- How to verify: a unit test calling `ensureHelper` twice with owners `user:1` and `user:2` and the same env should expect no stop. On device: two `bun run`-launched `warden e2e` runs should leave the same `state.json` helper pid.
- Confidence: med
- Verified by: traced `ensureHelper` → `staleReason` → `ownerKey` ← `detectOwner`

### 14-6 `state.json` read-modify-write without a lock: concurrent `warden ui` calls lose the helper record, video pid, recording or collector
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `state.ts:146-150@dfcc68b`: `writeState` replaces the whole file. Callers read first and write later outside any transaction: `helper.ts:393`, `helper.ts:584/594`, `video.ts:77→96` (spawn in between) and `:136`, `open.ts:104-105`, `flows-command.ts:94,112`, `devtools-cli.ts:304,321`.
  - Only the generation is protected (`commitGeneration`, `state.ts:158-169`).
- Impact: a lost `video` record leaves an orphan recorder (see 14-7) and `video stop` says "not recording". A lost `helper` record means `ui close` cannot SIGTERM the helper. A lost `recording` silently ends a flow recording. Parallel agent tool calls are enough to trigger it.
- Proposed fix: `updateState(ctx, udid, (s) => s')` that re-reads and writes inside `ctx.store().transaction` (the repo's cross-process mutex), used by every writer. Files: `state.ts` and the callers above (some owned by 10/11). Additive.
- Effort: S
- Risk: low
- How to verify: extend the `state.worker.testing.ts` pattern so N processes set different keys concurrently, and assert all keys survive.
- Confidence: high
- Verified by: read; grep of `writeState` callers

### 14-7 iOS `video` recorder outlives `ui close`, release and gc (orphaned `simctl io recordVideo`)
- Category: perf-cpu
- Severity: P2
- Known?: new
- Evidence:
  - `video.ts:91-99@dfcc68b`: a detached `xcrun simctl io <udid> recordVideo --force <path>` with its pid in `state.video`. Only `video stop` ends it (`:108-136`).
  - `close.ts:41-47@dfcc68b` stops the helper only. `stop-helper-after.ts:18-27@dfcc68b` (the release / gc `after` hook) stops the helper only. Nothing in gc sweeps `state.video`.
  - On Android, `screenrecord` self-stops at 3 min, but `video stop` runs `pkill -2 screenrecord` (`video.ts:115`), which ends every `screenrecord` on the device, not just ours.
- Impact: estimated. One H.264 encoder per forgotten recording keeps running until the sim shuts down (locally sims stay booted, PERF-4.8). The host CPU share is not measured (K2 has no per-process split), and disk use grows with the run.
- Proposed fix: stop `state.video` (SIGINT, wait, identity-checked as in 14-4) in `uiClose` and in the release `after` hook, and sweep dead or orphaned recorders in gc. On Android, kill the recorder by its pid (`pidof`) instead of `pkill`. Files: `video.ts`, `close.ts`, `stop-helper-after.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: a unit test where `ui close` with `state.video` set expects SIGINT to that pid. On device: `video start`, `ui close --release`, then `pgrep -f recordVideo` should be empty.
- Confidence: high
- Verified by: read

### 14-8 Android: every `warden ui` call rebuilds the whole driver (shell, probe, animations off/on, uiad start/stop)
- Category: perf-latency
- Severity: P1
- Known?: known-extended K17
- Evidence:
  - `apps/cli/src/agent-ui/ui-driver.ts:25-38@dfcc68b`: a fresh `openAndroidDriver` per process, closed by `runUi` (`run.ts:58-61`). One call does:
    1. `openAdbSession` (host `adb` client and an `adbd` shell).
    2. `waitForBoot` `BOOT_PROBE` = `getprop`×2 + `wm size` + `wm density` (`packages/e2e/src/driver/android/android-device.ts:34-41,62-74@dfcc68b`).
    3. `disableAnimations`: `settings get`×3 + `settings put`×3 in one shell line, plus a state-file write (`android-animations.ts:42-56@dfcc68b`).
    4. On the first snapshot or input, `ensureUiadDex` (a presence check, `uiad-device.ts:87-99`) and `launchUiad` (a second `adb shell` + `app_process`, ~85 ms, `wdn-perf.md:549`).
    5. The op itself.
    6. On close: `uiad.stop()`, `animations.restore()` = `settings put`×3 + a state write, and the session close (`android-driver.ts:594-599@dfcc68b`).

    That adds up to 3 adb clients and ~5 shell round trips around a 10-30 ms op.
  - Side effect: animations are restored at the end of every call, so between agent calls the app animates at normal speed. A `press` without `--settle` starts its transition after the restore, and the next call (which zeroes the scales again) can snapshot mid-transition.
- Impact:
  - measured under load 50-170: `ui press` 2400-4000 ms wall vs raw `input tap` 73-350 ms (`docs/plans/wdn-e2e.md:316`).
  - estimated on a quiet host: ~85 ms uiad start + 3 shell round trips × 30-80 ms + 9 `settings`/`wm` binder calls × 20-40 ms ≈ 0.4-0.6 s per call, against a 10-30 ms op.
- Proposed fix:
  - A lease-scoped resident server: `warden-uiad` in socket mode behind `adb forward localabstract:` (the transport is already an interface, `wdn-perf.md:549`), recorded in `state.json` like the iOS helper and stopped by the release `after` hook.
  - Keep animations off for the life of the `warden ui` lease and restore them in that hook (`policy_change`).
  - Cache the boot/screen probe in `android-state` keyed by boot id and sdk.

  Files: `ui-driver.ts`, `stop-helper-after.ts`, and e2e android (cross-owner 05).
- Effort: L
- Risk: med. One UiAutomation client per device: a resident server blocks `uiautomator dump`, Maestro and similar tools while the lease is held. Needs a device.
- How to verify: `warden ui bench --platform android` on a quiet host, and wall time of `warden ui press @eN` before and after. Count `adb` spawns per call with `WARDEN_DEBUG`, or by wrapping `adb` on the device.
- Confidence: med (the round trips are traced; the per-call ms are estimated)
- Verified by: traced `uiDriver` → `openAndroidDriver` → `waitForBoot` / `disableAnimations` / `launchUiad` → `close`

### 14-9 `--settle` and `wait stable` poll full snapshots by hash instead of using the driver's native settle
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `snapshot.ts:88-125@dfcc68b`: `fetchSnapshot` with `settle` runs `settleByHash` over `driver.snapshot()` (quiet 250 ms, poll 100 ms; `packages/e2e/src/driver/settle.ts:55-75`).
  - It is used by every action's `--settle` (`act.ts:69-76`) and by `snapshot --settle`. `wait stable` does the same (`query.ts:177-204`).
  - On a static screen that is at least 3 full snapshots plus 2 sleeps. The helper's stream settle answers quiet after ~260 ms (`packages/e2e/AGENTS.md:65`), and `warden-uiad` waits for accessibility events to stop.
  - A hash over role/id/label/value/frame (`settle.ts:77-96`) cannot see opacity or transform animations, so it can report "quiet" mid-transition.
- Impact:
  - measured: `pressSettle` p50 411.7-443.9 ms (`docs/plans/wdn-e2e.md:306,337`).
  - estimated with native settle: ~260 ms + one snapshot ~65 ms (`:335`) ≈ 325 ms, saving ~90-120 ms per settled action on iOS, plus fewer AX reads competing with the app.
- Proposed fix: `driver.settle({ quietMs: 250, timeoutMs: budget })`, then one `driver.snapshot()` for the diff. Fall back to `settleByHash` when `capabilities.nativeSettle` is false. Files: `snapshot.ts`, `query.ts`. Additive (the `settle` field shape is unchanged).
- Effort: S
- Risk: low. Re-run `warden ui bench`.
- How to verify: `ui.test.ts` with a FakeDriver that counts `settle` against `snapshot` calls, and `bun run smoke:ui-bench` for `pressSettle`.
- Confidence: high
- Verified by: read

### 14-10 AutomationEnabled probe/write runs after `ensureHelper` on the `ui` and warm paths (serial; on a fresh sim, after the AX guest started)
- Category: cold-boot
- Severity: P2
- Known?: new (the write itself is agent 16's)
- Evidence:
  - `helper.ts:523-534@dfcc68b` and `warm-connect.ts:16-25@dfcc68b`: `ensureHelper` first, then `openIosDriver({client})`.
  - In `ios-driver.ts:533-536@dfcc68b`, `Promise.all([connecting, simctl.enableAutomation()])` has an already-resolved client, so the `plutil` read (~10 ms) and, on a sim without the key, the `simctl spawn defaults write` (300-500 ms, `packages/e2e/AGENTS.md:78`; 380-480 ms measured, `docs/plans/wdn-e2e.md:341`) run after the helper's spawn and handshake.
  - The helper starts its quiescence stream (an AX guest) in the background at start (`packages/e2e/AGENTS.md:63`), so on a fresh sim the guest may start before the key is written.
  - `openDriver` runs both in parallel.
- Impact: estimated. 300-500 ms once per freshly created or erased sim on the warm path (the cold-boot case), plus ~10 ms on every warm `warden ui` call.
- Proposed fix: start `enableAutomation` before or alongside `ensureHelper`. Either pass a pending promise into `openIosDriver` (an additive option) or skip it when the resident record says it was already verified for this sim boot. Files: `helper.ts`, `warm-connect.ts`, and `ios-driver.ts` (cross-owner 03/16).
- Effort: S
- Risk: low. Needs a device to confirm the guest/key ordering.
- How to verify: `bun run smoke:ui-bench` `helperColdToSnapshot` on a freshly erased sim, before and after.
- Confidence: med
- Verified by: traced `connectHelper` / `warmConnect` → `openIosDriver` → `simctl.enableAutomation`

### 14-11 `swipe <dir>` / `scroll` take a full snapshot only for the screen size; `scroll --until` then snapshots again immediately
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence:
  - `actions.ts:361-375@dfcc68b`: `regionOf` → `currentScreen` → `driver.snapshot({interactiveOnly:true})`, keeping only `.screen`. `--in <selector>` adds a third snapshot (`:378`, via `pointAt` → `resolveSelector`).
  - `scroll.ts:87-90@dfcc68b`: the first loop iteration snapshots again before any swipe.
- Impact: estimated. One snapshot per call: iOS 64.6-106.3 ms p50 (`wdn-e2e.md:335`), Android uiad ~10-30 ms, dump fallback 1.9-8 s.
- Proposed fix: hand the region snapshot to the first loop iteration, or take the screen from `last-snapshot.json` or the driver. Files: `actions.ts`, `scroll.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: a `ui-actions.test.ts` FakeDriver snapshot count for `scroll down --until`.
- Confidence: high
- Verified by: read

### 14-12 Per-call fixed costs on the hot path that could be skipped
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence:
  1. `device.ts:178-179` → `claim-flags.ts:115-121@dfcc68b`: every call spawns a synchronous `git rev-parse` (`packages/core/src/git-facts.ts:99,123-133`) only to put `repo/worktree` on the owner. `sameOwner` ignores both (`packages/core/src/types.ts:95-100`), so this is needed only when a lease is inserted (`--claim`).
  2. `snapshot.ts:140@dfcc68b` reads and zod-parses the whole `last-snapshot.json` on every snapshot but uses it only for the `--settle` diff (`:174`). `act.ts:122` does the same for point and selector targets. In a scratch run, the first parse in a fresh process (121 elements, recursive `z.lazy`) was ~13 ms (noisy host; indicative only).
  3. `ui-driver.ts:1-6@dfcc68b` statically imports the Android driver, `uiad-backend` and the 36 KB dex module (`uiad-device.ts:7`) for every iOS call.
  4. `snapshotHash` is computed twice per stored snapshot (`snapshot.ts:144-145` and `:244`).
- Impact: estimated 20-30 ms per `warden ui` call (git spawn ~5-10 ms + parse ~10 ms + module eval of a few ms).
- Proposed fix: resolve git facts only on the claim path, read `last-snapshot` lazily, split `ui-driver.ts` into per-platform dynamic imports, and reuse the hash. Additive.
- Effort: S
- Risk: low. `startup.test.ts` can guard the import change.
- How to verify: `startup.test.ts` asserts the Android modules are absent for `ui snapshot` on an iOS device; hyperfine `warden ui snapshot -i` on a quiet host.
- Confidence: med
- Verified by: read; ran a scratch timing of `readLastSnapshot`

### 14-13 Helper race and leak paths are untested; the multi-process race test can pass without a collision
- Category: test-gap
- Severity: P3
- Known?: new
- Evidence:
  - `helper.integration.test.ts:86-104@dfcc68b`: 4 `bun` processes aim at `startAt = now + 600 ms`. If start-up takes longer under load, they arrive in sequence and the "exactly one spawn" assertion holds trivially. Nothing asserts that a waiter actually took the WAIT path.
  - `helper.test.ts:197-208@dfcc68b` ("never listens") asserts that the row is released, not that the spawned child is stopped (14-1).
  - There is no test for `stopHelper` racing `ensureHelper` (14-3) or for the slow-`ready` case (14-2).
- Impact: n/a (regressions in 14-1/2/3 stay green).
- Proposed fix: have the fixture write a marker when it took the WAIT branch (via an injected `sleep`) and assert at least one. Add unit tests for 14-1/2/3.
- Effort: S
- Risk: low
- How to verify: `bun test apps/cli/src/agent-ui/helper*.test.ts`
- Confidence: high
- Verified by: ran `bun test` on the helper/state/lease tests (107 pass); read

### 14-14 `ui close --app` spawns a helper just to terminate the app, then stops it; the driver is closed twice
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence:
  - `close.ts:33-37@dfcc68b`: `env.driver()` → `connectHelper` → `ensureHelper`, which spawns a cold helper when none is resident (`helper.ts:442-457`) for a `simctl terminate`. `:46` then stops it.
  - `close.ts:36` closes the driver, and `run.ts:58-61` closes it again.
- Impact: estimated. ~1-3.6 s (`helperColdToSnapshot` p50 958.9-3593.1, `wdn-e2e.md:334`) per `close --app` with no resident helper. iOS.
- Proposed fix: terminate through `simctl` directly (`createSimctl(...).terminate`) when no helper is resident. Additive.
- Effort: S
- Risk: low
- How to verify: a `ui.test.ts` case where `close --app` with no helper record expects no `spawnDetached`.
- Confidence: high
- Verified by: read

## Known items

- K17: known-extended. On top of the ~85 ms `warden-uiad` start, each Android call pays an adb shell, the boot/screen probe, 6 `settings` calls on open and 3 on close, a dex check and a second adb client. Animations flip back on between calls (14-8).
- K9: not touched. No change to key pacing is proposed.
- K7: not touched. 14-1/14-2/14-3 cause a different source of slow `via:"snapshot"` settles (two helpers per sim). Report them separately from the wedge.

Prior-read corrections:
- "First connect with `readyTimeoutMs: 2000` always fails on a cold helper (2 s wasted)" is wrong. With no socket file the connect fails immediately; the 2 s applies only to a helper that accepts but is slow to send `ready` (14-2).
- "`last-snapshot.json` + `state.json` atomic writes per snapshot" is wrong. A snapshot writes `last-snapshot.json` plus the `ui_generation:<udid>` meta row; `state.json` is not rewritten per snapshot.
- "Measured 182-185 ms warm" is the bench's iOS prepare (`wdn-perf.md:646`), not a `warden ui snapshot -i` call. No per-call iOS `warden ui` wall time is measured in the docs.

## Gaps I could not assess here

- Per-call wall time of iOS `warden ui snapshot -i` (process start through render): on a quiet Mac with a resident helper, run `hyperfine -w 3 'warden ui snapshot -i --udid <udid>'`, compare it with `warden ui bench` `snapshotWarm`, and attribute the difference with `WARDEN_DEBUG`/`--debug` spans.
- 14-1 frequency: run `warden e2e` on a freshly booted sim under load, then `grep "not warm" <logDir>/warm-*.log` and `ps -axo pid,command | grep 'warden-simd --udid'`. Expect one per sim.
- 14-2: does a resident helper ever take more than 2 s to send its per-connection `ready` while busy (in the middle of a `snapshot` or `rebind`)? Connect in a loop during a `warden e2e` run and log the handshake ms.
- 14-7: host CPU of an idle `simctl io recordVideo` (`top -pid <pid>` for 60 s).
- 14-8: on a quiet emulator, count `adb` invocations and the ms per step of one `warden ui press @eN` (wrap `adb` with a logging shim via `ANDROID_HOME`), then compare with a resident-server prototype.
- 14-10: does the AX guest of a helper started before `AutomationEnabled` was written work? Use a freshly erased sim: `warden ui snapshot -i` once, then check `backend` and the helper log.

## Owned files not read

- `apps/cli/src/commands/ui.testing.ts`, `ui-actions.test.ts`, `ui-query.test.ts`, `ui-snapshot.test.ts`, `state.real.test.ts`, `diff.ts` / `diff.test.ts`, `output.ts`: skimmed or not read line by line; nothing in them changes the findings.
- `controls.ts` beyond line 80.

## Questions for the user

1. Is replacing the resident helper on every owner change (14-5) meant to cover `user:<ppid>` churn from `bun run` scripts, or only a real hand-over between people or agents? The answer decides whether the fix keys on env/binary or keeps the owner key.
2. Is it acceptable for a `warden ui` lease on Android to keep animations off, and to hold the UiAutomation slot with a resident server, until release (14-8)?

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-14.md, apps/cli/AGENTS.md (CLAUDE.md), packages/e2e/AGENTS.md (CLAUDE.md)
- docs/plans/wdn-perf.md (§ PERF-1.5, :43, :549, :646), docs/plans/wdn-e2e.md (§ speed targets, Android real-device pass, ui-bench after D11)
- apps/cli/src/agent-ui/{helper,helper-sweep,helper.race-fixture,state,paths,snapshot,snapshot-command,act,actions,target,query,scroll,close,status,stop-helper-after,run,driver,ui-driver,device,ui-options,open,video,flow-sink (append path)}.ts, controls.ts (1-80)
- apps/cli/src/agent-ui/helper.test.ts (test list, :195-210), helper.integration.test.ts (:80-110)
- apps/cli/src/commands/ui.ts (1-80), apps/cli/src/device-lease.ts, apps/cli/src/claim-flags.ts (resolveOwner), apps/cli/src/startup.test.ts (ui section)
- apps/cli/src/e2e/warm-connect.ts, apps/cli/src/batch/warm-drivers.ts, apps/cli/src/batch/early-warm.ts, apps/cli/src/commands/batch.ts (:667-669), apps/cli/src/commands/e2e.ts (warm hook)
- packages/e2e/src/driver/ios/{simd-client,simd-transport (socketTransport),ios-driver (open/connect),simctl (enableAutomation)}.ts
- packages/e2e/src/driver/android/{android-driver (open/close),android-animations,android-device (probe),uiad-device (dex/launch)}.ts, packages/e2e/src/driver/settle.ts
- packages/core/src/{owner,git-facts}.ts, packages/core/src/types.ts (sameOwner)
