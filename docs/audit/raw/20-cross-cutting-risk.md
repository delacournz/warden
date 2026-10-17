# 20 · cross-cutting-risk

Auditor 20, commit `dfcc68b`. Scope: correctness and robustness gaps that cross file owners, or that sit in the exclusive themes (signals and teardown, argv quoting, `$WARDEN_HOME` state, dropped results, detached children). Performance is out of scope here, except where a robustness gap costs measured time (20-1).

## Top 5 by impact

- 20-1: a cold or failed warm-up makes every iOS job spawn a second `warden-simd` on stdio while the resident socket helper lives on. Two quiescence streams then run on one sim and every `settle` drops from ~258 ms to 2.4–2.9 s.
- 20-2: SessionEnd (including `/clear`, where "the work usually continues") releases and stops the helpers behind a `warden e2e`/`batch` that is still running. `holdLeases` ignores the 0 rows `heartbeat()` reports, so the run carries on with devices it no longer holds.
- 20-3: `stopHelper`, `video stop` and `logs stop` send SIGTERM, SIGINT or SIGKILL to a pid read from `state.json`, and the only identity check is `kill(pid, 0)`. After a helper crash or a host reboot, a reused pid can belong to an unrelated user process.
- 20-6: on Android, two drivers on one serial (`warden ui` calls run in parallel, or `warden ui` during your own e2e job) each kill the other's live `warden-uiad` as "stale, ours". They keep doing it until both give up and fall back to `uiautomator dump`.
- 20-8: a `WARDEN_SIMD_SOCKET` in the parent environment reaches the jobs of every device that did not warm, and the helper's `ready.udid` is never compared against the device. Those jobs drive another simulator.

## Findings

### 20-1 Failed or skipped warm-up runs a second helper per job beside the resident one (two quiescence streams per sim)
- Category: flake-risk
- Severity: P1
- Known?: new (the two-stream degradation itself is documented in `packages/e2e/AGENTS.md:65`. It may also feed K7, the AX wedge)
- Evidence:
  - `ensureHelper` spawns a resident socket helper (`apps/cli/src/agent-ui/helper.ts:384@dfcc68b`). The warm step then takes one snapshot.
  - When that snapshot fails, `warmOne` calls `helper.close()` (`apps/cli/src/batch/warm-drivers.ts:75,78@dfcc68b`). The 120 s timeout or SIGINT path does the same through `late` (`warm-drivers.ts:116@dfcc68b`).
  - That `close` is `driver.data.close()` (`apps/cli/src/e2e/warm-connect.ts:36@dfcc68b`). It only disconnects; the helper process stays resident with its quiescence stream open (`packages/e2e/AGENTS.md:63`).
  - That device then gets no socket: `settleWarm` only fills `sockets` for devices whose warm-up succeeded (`apps/cli/src/commands/batch.ts:1159-1161@dfcc68b`). `socketEnv(undefined)` adds nothing (`batch.ts:668-669@dfcc68b`).
  - With no socket, each spec process's `openIosDriver` → `connect` → `spawnSimd` starts its own stdio helper (`packages/e2e/src/driver/ios/ios-driver.ts:502-516@dfcc68b`).
  - The same thing happens per job when a socket is set but `connectSimd` fails under load (`ios-driver.ts:496-499@dfcc68b`: "spawning a helper on stdio instead"). It also happens with `--no-warm` / `warmDrivers:false` while a helper from an earlier `warden ui` or e2e run is still within its 10 min idle window (`helper.ts:39@dfcc68b`).
  - None of these paths checks for, or uses, the `simd_spawn:<udid>` arbitration or the resident helper. The repo's own rule is one helper per sim (`packages/e2e/AGENTS.md:63,65`).
- Impact: measured degradation: with a second helper's stream open, `settle` falls from 258 ms to `via:"snapshot"` at 2.4–2.9 s, in both helpers (`docs/plans/wdn-e2e.md:384`). Estimated cost: at least 1 settle per test (`app.open({wait:"quiet"})`) × ~2.2 s ≈ +2.2 s/test, ≈ +17 s per 8-test rep. A suite that settles after each action pays several times that. Platform: iOS. It also makes the warm failure ("only ever a warning") self-reinforcing for the rest of the run.
- Proposed fix (additive):
  - (a) When a device's warm-up fails after `ensureHelper` succeeded, still hand its jobs the socket path. The helper is up; only the snapshot failed. Or stop it (`stopHelper`) so the jobs' stdio helpers are alone.
  - (b) In `ios-driver.ts` `connect`, when a socket was configured but did not answer, retry once after ~500 ms before spawning on stdio, and log loudly.
  - (c) `warden e2e --no-warm` should stop a resident helper on its devices first, or pass its socket anyway.
  - Files: `apps/cli/src/batch/warm-drivers.ts`, `apps/cli/src/e2e/warm-connect.ts`, `apps/cli/src/commands/batch.ts` (`settleWarm`), `packages/e2e/src/driver/ios/ios-driver.ts`.
- Effort: S
- Risk: low. Handing over a socket whose snapshot failed could hand the jobs a wedged helper; (a) with `stopHelper` avoids that. A device check is needed to confirm the settle numbers.
- How to verify: batch harness test with a `warmConnect` whose `snapshot` fails, asserting the job env still carries `WARDEN_SIMD_SOCKET` (or that a stop was issued). On a device: force a warm failure (`WARDEN_SIMD_SOCKET` unset, resident helper alive), run `warden e2e example`, and grep spec logs for `via:"snapshot"` settles.
- Confidence: high (mechanism); med (frequency of warm failures)
- Verified by: traced path from `startEarlyWarm` → `warmOne` → `settleWarm` → `jobRunner.plan` → `openIosDriver.connect`; ran `bun test apps/cli/src/batch/warm-drivers.test.ts` (green: no test covers the job env after a failed warm-up)

### 20-2 SessionEnd (and `/clear`) releases a live run's leases and stops its helpers; the run never notices
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - `handleSessionEnd` releases every lease the agent session owns, with `reason: "clear"` too (`apps/cli/src/hooks/claude-pretool.ts:79-97@dfcc68b`). The test pins this: "/clear releases but leaves devices running (the work usually continues)" (`claude-pretool.test.ts:105-110`).
  - With devices it hands off to a detached `warden release --session S --shutdown` (`apps/cli/src/commands/hook.ts:15-20@dfcc68b`). That shuts the sims down, then `releaseDevices` runs with `stopHelperAfter` (`apps/cli/src/commands/release.ts:95-112@dfcc68b`).
  - A `warden e2e` / `batch` the same agent started has the same owner. `resolveOwner` → `detectOwner` reads `CLAUDE_CODE_SESSION_ID` / `WARDEN_SESSION_ID` (`packages/core/src/owner.ts:17,34-36@dfcc68b`). So its device and port leases are in that list.
  - The run's `holdLeases` heartbeat discards the result of `store.heartbeat` (`apps/cli/src/lease-session.ts:471-473@dfcc68b`), which returns the number of rows updated (`packages/core/src/store.ts:272-276@dfcc68b`). Once the rows are gone it updates 0 rows, silently.
  - Nothing aborts the run. Its jobs keep driving devices that a new `warden claim` from another agent can now take (`device_foreign` no longer fires). The detached worker shuts the sims down under running jobs and stops the helper whose socket the jobs use.
- Impact: lost lease, and the same device driven by two owners. On a non-`/clear` exit: a mid-run sim shutdown that shows up as a red flow and never names the cause. Platform: both. Trigger: the agent runs `warden e2e` in a background shell, then the user types `/clear` or ends the session. A user `warden release --mine` from the same session shell does the same.
- Proposed fix:
  - (a) `holdLeases`: when `heartbeat()` updates fewer rows than `leaseIds.length`, call `onSignal`-style abort with a clear "leases were released by someone else" error.
  - (b) `handleSessionEnd` with `reason: "clear"`: skip leases held by a live process. Lease `pid` is alive and the heartbeat is fresh: `isLeaseAlive` with `pidAlive`. Or skip leases whose label is `warden e2e`/`warden batch` with a live pid.
  - Files: `apps/cli/src/lease-session.ts`, `apps/cli/src/hooks/claude-pretool.ts`. Additive. (b) is `policy_change` (it changes what `/clear` releases).
- Effort: S
- Risk: med. (b) could keep a lease that a crashed run left behind, though pid liveness covers that. No device needed: fake store and fake `every`.
- How to verify: unit test: `holdLeases` with leases deleted between ticks → the abort callback fires. Hook test: a lease with a live pid survives `reason:"clear"`.
- Confidence: med (that Claude Code keeps background shells across `/clear` is assumed; the code path is certain)
- Verified by: read; ran `bun test apps/cli/src/hooks/claude-pretool.test.ts` (green: no test has a concurrent holder)

### 20-3 Recorded-pid kills have no identity check (helper SIGTERM, video SIGINT→SIGKILL, collector SIGTERM)
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - The helper, video and collector pids live in `$WARDEN_HOME/ui/<udid>/state.json` (`apps/cli/src/agent-ui/state.ts:22-29@dfcc68b`). The only liveness test is `kill(pid,0)` (`packages/core/src/liveness.ts:12-18@dfcc68b`).
  - `stopHelper`:
    - It treats the helper as running when the socket file exists or the pid is alive (`apps/cli/src/agent-ui/helper.ts:566@dfcc68b`).
    - A helper that crashed (SIGKILL, OOM, host reboot) leaves both the socket file (`$WARDEN_HOME/simd/<udid>.sock`, which survives a reboot) and the record.
    - If the pid has since been reused, `connect` fails and `gone()` stays false, because the socket exists and the pid is alive (`helper.ts:571@dfcc68b`). After 2 s it sends `SIGTERM` to that pid (`helper.ts:578-581@dfcc68b`).
  - `video stop` sends SIGINT and then SIGKILL to `state.video.pid` (`apps/cli/src/agent-ui/video.ts:124-131@dfcc68b`). `logs stop` sends SIGTERM to `state.collector.pid` (`apps/cli/src/agent-ui/devtools-cli.ts:319@dfcc68b`).
  - The same reused pid also makes `video start` / `logs start` refuse with "already recording" / "already collecting" (`video.ts:81`, `devtools-cli.ts:281@dfcc68b`). `sweepDeadHelpers` then never sweeps that record (`helper.ts:623@dfcc68b`).
  - Callers that reach `stopHelper`: `release --shutdown`, `ui close`, the SessionEnd worker, gc, and `shutdownReleasedDevices` (`apps/cli/src/device-shutdown.ts:55@dfcc68b`).
- Impact: a foreign host process gets SIGTERM or SIGKILL. It is rare (it needs a crash or reboot plus pid reuse), but it breaks the read-only rule for things warden does not own. Platform: host (iOS helper; video and collector on both).
- Proposed fix (additive; store state.json fields optional): record the process start time (`ps -o lstart= -p <pid>`), or check the command line (`ps -o command= -p <pid>` contains `warden-simd --udid <udid>` / `recordVideo` / `ui-collect`) before every signal and in `pidAlive` for these records. Put one `ownedPidAlive(record)` helper in `agent-ui/state.ts` or core `liveness.ts`, and use it in `helper.ts`, `video.ts` and `devtools-cli.ts`.
- Effort: S
- Risk: low. An extra `ps` (about 10 ms) per stop. Verifiable with an injected `pidAlive`/`kill` and no device.
- How to verify: unit test: a record whose pid is alive but whose argv is not `warden-simd` → `stopHelper` unlinks the socket and forgets the record without calling `kill`.
- Confidence: high
- Verified by: read; traced `release --shutdown` → `stopHelperAfter` → `stopHelper`

### 20-4 `warden ui video start` recorder outlives release, close, gc and SessionEnd
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - The recorder is started detached and unref'd (`apps/cli/src/agent-ui/video.ts:33@dfcc68b`), and only `video stop` ends it (`video.ts:108-136@dfcc68b`). iOS `simctl io recordVideo` has no time limit; Android `screenrecord` stops after 3 min on the device.
  - `ui close` / `ui close --release` stop the helper only (`apps/cli/src/agent-ui/close.ts:41-47@dfcc68b`).
  - `releaseDevices` runs only the `after` hook (`apps/cli/src/device-lease.ts:129-142@dfcc68b`), and every caller passes `stopHelperAfter`, which stops only `warden-simd` (`apps/cli/src/agent-ui/stop-helper-after.ts:20-27@dfcc68b`).
  - SessionEnd and gc go through the same hook (`claude-pretool.ts:93-97@dfcc68b`).
  - The device then passes to the next owner with a live recorder and a `state.video` record. The next owner's `video start` fails "already recording". The recorder keeps h264-encoding the sim's screen and growing the file, until the sim shuts down, which warden never does for a foreign or kept sim.
- Impact: estimated: an orphan h264 encoder per forgotten recording (host CPU, unbounded disk) and a blocked `video start` for the next owner. Platform: iOS mainly.
- Proposed fix (additive): in `stopHelperAfter`, or in a new `stopUiChildrenAfter`, also stop a recorded `video` (SIGINT, wait, then the Android pull) and the `collector`, and drop their records. Or make `ui close` stop them. Files: `apps/cli/src/agent-ui/stop-helper-after.ts`, `video.ts`, `close.ts`.
- Effort: S
- Risk: low. A user who wants a recording to survive a release loses that, which is an unlikely need. No device needed (fake video deps).
- How to verify: unit test: `video start` → `ui close --release` → the fake `kill` saw SIGINT for the recorder's pid and `state.video` is gone.
- Confidence: high
- Verified by: read

### 20-5 `state.json` read-modify-write is unlocked: parallel `warden ui` calls drop helper / video / collector / recording records
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `writeState` writes atomically (temp file plus rename), but every caller writes a snapshot of `readState` it took earlier (`apps/cli/src/agent-ui/state.ts:146-150@dfcc68b`). Only `generation` is protected, under `commitGeneration`'s transaction (`state.ts:160-171@dfcc68b`).
  - Writers:
    - `spawnHelper` (`apps/cli/src/agent-ui/helper.ts:393@dfcc68b`)
    - `video start` (reads at `video.ts:77`, writes at `video.ts:96@dfcc68b`)
    - `logs start` (`devtools-cli.ts:304@dfcc68b`)
    - `ui open` (`open.ts:104-105@dfcc68b`)
    - `record start` (`flows-command.ts:94@dfcc68b`)
    - `forgetHelper` (`helper.ts:594@dfcc68b`)
  - Agents issue tool calls in parallel, for example `warden ui video start` and `warden ui snapshot` (the first call spawns the helper). One write then drops the other's field:
    - A lost `helper` record disables the owner-changed and binary-changed replacement (`staleReason` returns undefined with no record, `helper.ts:339-340`) and gc's sweep.
    - A lost `video` or `collector` record leaves a detached process that no command can stop (it compounds 20-4).
- Impact: an orphaned recorder, or a resident helper reused by the next lease owner (`AGENTS.md`: "replaced when the lease passed to another owner"). Platform: both.
- Proposed fix (additive): an `updateState(ctx, udid, (s) => s')` that reads and writes inside `store.transaction` (BEGIN IMMEDIATE is the repo's cross-process mutex). Switch every caller to it. Files: `apps/cli/src/agent-ui/state.ts` plus the 6 callers.
- Effort: S
- Risk: low. The store is already opened by these commands. Test with `state.worker.testing.ts`-style workers.
- How to verify: a race test in the style of `helper.race-fixture.ts`: N workers each add a distinct field, and all fields are present at the end.
- Confidence: high (mechanism); med (frequency)
- Verified by: read

### 20-6 Android: concurrent drivers on one serial kill each other's live `warden-uiad`
- Category: flake-risk
- Severity: P2
- Known?: known-extended K17 (one server start per `warden ui` call; daemon mode optional)
- Evidence:
  - When the UiAutomation slot is busy, `launchUiad` lists holders with `ps -A -o PID,ARGS` and treats every process that matches `UIAD_MAIN_CLASS` as "a server of ours that nobody is talking to any more" (`packages/e2e/src/driver/android/uiad-device.ts:104-106,125@dfcc68b`). It kills them, even ones in active use by another host process (`uiad-device.ts:170-181@dfcc68b`).
  - The victim's next call fails, so `failed()` drops its server (`uiad-backend.ts:163-168@dfcc68b`). Its next `server()` starts again and kills the first process's server in turn (`uiad-backend.ts:150-161@dfcc68b`). The ping-pong goes on until `MAX_RESTARTS` / `MAX_START_FAILURES` switches both to `uiautomator dump`.
  - iOS has host-side arbitration (the `simd_spawn` row plus one shared socket); Android has none.
  - Realistic triggers: two parallel `warden ui` calls on one emulator, or `warden ui snapshot` against the agent's own leased emulator while its `warden e2e` job runs. `ensureCallerLease` allows a same-owner caller (`apps/cli/AGENTS.md`).
- Impact: failed ops in both processes, then ~1.9 s `uiautomator dump` per read for the rest of the driver's life (dump cost: `packages/e2e/src/expect/matchers.ts:13`). Platform: Android.
- Proposed fix (additive): take a `uiad:<serial>` store meta row (pid plus time, like `simd_spawn`) while a server is owned. Kill an "ours" holder only when the row's pid is dead or absent; otherwise return busy and use the dump for that call. Files: `uiad-device.ts`, `uiad-backend.ts`, plus a way to pass a store and lock from the CLI (`apps/cli/src/agent-ui/driver.ts`). Longer term, K17's daemon mode removes the race.
- Effort: M
- Risk: med. The e2e package has no store today, so the arbitration has to be injected (`open.ts`). A device check is needed for the ping-pong timing; the fakes (`uiad.testing.ts`) can test the kill decision.
- How to verify: `uiad-device` unit test: a busy start with an "ours" holder whose lock row has a live pid → no `kill` sent. On a device: run `warden ui snapshot --serial S` twice in parallel in a loop and count `killing it` lines.
- Confidence: med
- Verified by: read

### 20-7 SIGHUP / SIGKILL of `warden e2e|batch` leaves detached jobs and Metro running unsupervised
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - Only SIGINT and SIGTERM are forwarded (`apps/cli/src/lease-session.ts:20,474@dfcc68b`; `batch.ts:1640@dfcc68b`). SIGHUP (terminal tab closed, ssh drop, `tmux kill-session`) takes the default action, so no `finally`, no `teardown`, no `session.release()` (`batch.ts:1458-1462@dfcc68b`).
  - `warden e2e` always sets `jobTimeoutMs` (`apps/cli/src/commands/e2e.ts:555@dfcc68b`). Every job is therefore a `group` spawn (`batch.ts:733-734@dfcc68b`), meaning `detached: true` (`batch.ts:1793@dfcc68b`) in its own session, so it does not get the terminal's SIGHUP.
  - Metro and serve are group spawns too (`batch.ts:1002,1208@dfcc68b`).
  - The job watchdog lived in the dead parent (`batch.ts:641-660@dfcc68b`). A hung orphan job is never shot.
  - Device and port leases stay alive for up to 30 min even though their pid is dead: `isLeaseAlive` returns true while the heartbeat is inside the TTL, before it looks at the pid (`packages/core/src/liveness.ts:7-8@dfcc68b`; TTL `config.defaults.ts:2`).
- Impact: orphan bun test processes keep driving leased sims, an orphan Metro holds the port, and the devices are blocked for ≤ 30 min. Platform: both.
- Proposed fix: add `SIGHUP` to `ForwardedSignal` and the subscriptions (same teardown). Optionally, add a parent-death check in jobs: the e2e preload polls `process.ppid` changing to 1 and exits. Files: `apps/cli/src/lease-session.ts`, `apps/cli/src/commands/batch.ts`, `dev.ts`, `run.ts`. Additive.
- Effort: S
- Risk: low. No device needed (`deps.onSignal` is injected).
- How to verify: batch test: firing `SIGHUP` through the fake `onSignal` aborts and kills jobs like SIGINT does. By hand: run `warden e2e example` in a terminal, close the tab, then check `pgrep -f "bun test"` / `lsof -i :<port>`.
- Confidence: high
- Verified by: read; traced `runSession` → `supervise` → `jobRunner.spawnOnce` → `defaultBatchDeps.spawn`

### 20-8 Inherited `WARDEN_SIMD_SOCKET` reaches the jobs of devices that did not warm, and the helper's udid is never checked
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - The job env is `childEnv(ctx.env, …)`, the whole parent env (`apps/cli/src/lease-session.ts:423@dfcc68b`), then `poolEnv` (which strips only `WARDEN_UDID_<n>`, `batch.ts:929@dfcc68b`), then `socketEnv`, which adds a socket only for warm devices and never deletes an inherited one (`batch.ts:668-669,704-706@dfcc68b`).
  - The skill documents `WARDEN_SIMD_SOCKET` as an env var to set when running specs by hand (`skills/warden/references/specs.md:200`). An agent shell that exported it for one sim, then ran `warden e2e` on 2+ devices, gives every cold device's jobs that one socket.
  - `trySocket` connects to it (`packages/e2e/src/driver/ios/ios-driver.ts:492-500@dfcc68b`). The handshake carries `ready.udid` (`simd-protocol.ts:179-187@dfcc68b`), but nothing compares it with `o.udid`, so input and AX go to the other simulator. That may be another owner's leased device.
- Impact: wrong device touched; flows fail or pass against the wrong screen. Platform: iOS.
- Proposed fix (additive): (a) in `openIosDriver`, reject a socket client whose `ready.udid !== o.udid` (close it and fall back to stdio, or fail with `E_HELPER`). (b) In `poolEnv`/`plan`, delete an inherited `WARDEN_SIMD_SOCKET` before `socketEnv`. Files: `packages/e2e/src/driver/ios/ios-driver.ts`, `apps/cli/src/commands/batch.ts`.
- Effort: S
- Risk: low. Test with `simd.testing.ts` and no device.
- How to verify: ios-driver unit test: a fake socket whose ready udid differs → no ops are sent to it. Batch test: an inherited socket is absent from a cold device's job env.
- Confidence: med (needs an exported env; the missing udid check is certain)
- Verified by: read

### 20-9 `doctor --fetch-helper` deletes the directory a resident helper runs from
- Category: robustness
- Severity: P3
- Known?: new (interacts with K7: guest recycles read `Resources/`)
- Evidence:
  - `tarExtractHelper` does `rmSync(destDir)` then `renameSync(files, destDir)` on `$WARDEN_HOME/simd/<version>/` (`apps/cli/src/update/fetch-helper.ts:95-96@dfcc68b`).
  - A resident `warden-simd` from that directory reads its guest binary and shims from `Resources/` (`packages/e2e/native/ios/Sources/warden-simd/Device/Session.swift:104-105`). The guest is re-spawned on every recycle (12 s max age, K7).
  - Between the swap and the next `ensureHelper`, which replaces the helper on the binary mtime (`helper.ts:345-354@dfcc68b`), a recycle in a running job can fail.
- Impact: an AX bridge failure mid-run when the agent runs `warden doctor --fetch-helper` during a run. Platform: iOS.
- Proposed fix (additive): extract to a new versioned directory (`<version>-<sha8>`) and leave the old one in place for gc, or refuse while a helper from `destDir` is alive (`state.json` records `binary.path`).
- Effort: S
- Risk: low.
- How to verify: on a device, run `warden doctor --fetch-helper` during `warden e2e example`, then look for guest spawn errors in `simd/<udid>.log`.
- Confidence: med
- Verified by: read

### 20-10 `warden install` writes `~/.claude/settings.json` non-atomically, after a prompt
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - `guardedWrite` reads the settings, shows a diff, waits for the confirmation prompt, then calls `writeFileSync(path, after)` (`apps/cli/src/commands/install.ts:213-214@dfcc68b`).
  - The same file defines `atomicWrite` (temp file plus rename, `install.ts:54-61`) but this step does not use it.
  - If Claude Code rewrites `settings.json` while the prompt is open (a permission grant), that change is lost. A crash mid-write truncates the user's settings.
- Impact: lost user settings (rare). Platform: host.
- Proposed fix: use `atomicWrite`, and re-read and re-merge just before writing (abort if `before` changed). File: `apps/cli/src/commands/install.ts`.
- Effort: S
- Risk: low.
- How to verify: unit test: change the file between the prompt and the write → step reports `error`/`skipped`, and the external edit is kept.
- Confidence: high
- Verified by: read

### 20-11 A second Ctrl-C does not escalate; teardown can block for ~45 s
- Category: dx
- Severity: P3
- Known?: new
- Evidence:
  - The SIGINT handler only aborts and forwards (`batch.ts:1372-1375@dfcc68b`); repeated signals do the same.
  - `teardown` runs `stopServe` (≤ 15 s grace, `batch.ts:219,328-335`), then recordings (≤ 15 s each in parallel, `apps/cli/src/batch/record.ts:16,48`), then Metro (≤ 15 s, `metro.ts:45,146-153@dfcc68b`), one after another.
  - A user who presses Ctrl-C again gets nothing, and typically follows with `kill -9` or closes the tab. Both lead into 20-7.
- Impact: dx; it feeds 20-7. Platform: both.
- Proposed fix: on the second signal, send SIGKILL to the groups (jobs, serve, Metro, recorders), release the leases synchronously, and exit 130. File: `apps/cli/src/commands/batch.ts`.
- Effort: S
- Risk: low. A recording killed this way is not finalised, which is acceptable on a forced exit.
- How to verify: batch test with a fake `onSignal` fired twice → `session.release` is called and the kill signals are SIGKILL.
- Confidence: high
- Verified by: read

## Known items

- K7: not changed. 20-1 (a second helper's stream per job) and 20-9 (guest Resources swapped under a live helper) are two more ways the AX guest can be disturbed. Both are worth ruling out on a device before tuning `WARDEN_SIMD_GUEST_MAX_AGE_S`.
- K17: known-extended (20-6). Because a server is started per call and holders are classified "ours = stale", concurrent Android drivers kill each other's live servers. The daemon mode, or a store-arbitrated `uiad:<serial>` row, fixes both.

## Gaps I could not assess here

- 20-1 frequency: how often the warm snapshot fails or times out on a cold 4-sim claim. Run `warden e2e example --platform ios` 5× from a cold boot and grep `logs/warm-*.log` for `not warm`. Then grep spec logs for `spawning a helper on stdio instead` and `via:"snapshot"`.
- 20-1 cost: on one sim, keep a resident helper alive and run the bench with `--no-warm`. Compare per-test wall time with `docs/bench/ios-2026-10-16-perf.md`.
- 20-2: whether Claude Code keeps a background `warden e2e` running across `/clear`. Start one with `run_in_background`, type `/clear`, then run `warden ls --json` mid-run.
- 20-6: on an emulator, run `for i in 1..20; do warden ui snapshot --serial S & warden ui snapshot --serial S; wait; done` and count `killing it` and `uiad: off` lines.
- 20-9: on a device, run `warden doctor --fetch-helper` during a suite, then check `$WARDEN_HOME/simd/<udid>.log` for guest spawn failures.

## Owned files not read

- `apps/cli/src/update/{build-info,release,npm-registry,package-install,source-build,tar,version}.ts`: read only where `update.ts` calls them (the download and install path). Not audited line by line.
- `apps/cli/src/hooks/{claude-settings,codex-hooks,agents,text-diff}.ts`: not read beyond what `install.ts` shows of them.
- `apps/cli/src/commands/doctor.ts`, `doctor-helper.ts`: only the fetch-helper path, through `update/fetch-helper.ts`.

## Questions for the user

1. Is `/clear` meant to release a lease that a still-running `warden e2e`/`batch` holds (20-2), or only the leases of finished commands? The answer decides whether the fix is the abort in `holdLeases` alone or also a policy change in the hook.

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-20.md, AGENTS.md, apps/cli/AGENTS.md (via CLAUDE.md), packages/e2e/AGENTS.md (lines 62-65), docs/plans/wdn-e2e.md (lines 31, 116, 381-384), skills/warden/SKILL.md, skills/warden/references/specs.md:200
- apps/cli/src/agent-ui/{helper,stop-helper-after,state,close,video,open}.ts; apps/cli/src/agent-ui/devtools-cli.ts (grep)
- apps/cli/src/e2e/warm-connect.ts; apps/cli/src/batch/{warm-drivers,early-warm,record}.ts
- apps/cli/src/commands/{batch,hook,release,install,update}.ts (relevant ranges); apps/cli/src/commands/ui-collect.ts (grep); apps/cli/src/commands/e2e.ts (grep)
- apps/cli/src/{lease-session,device-lease,device-shutdown,autogc,metro,claim-flags}.ts
- apps/cli/src/hooks/claude-pretool.ts (+ its test); apps/cli/src/update/{install-binary,install-origin,fetch-helper}.ts
- packages/core/src/{claim,liveness,owner,store (heartbeat)}.ts; packages/core/src/builds/lock.ts; packages/core/src/batch/expand.ts
- packages/e2e/src/driver/ios/{ios-driver (480-560),simd-protocol (175-250),simd-client (grep)}.ts; packages/e2e/src/driver/android/{android-argv,uiad-backend,uiad-device}.ts; packages/e2e/src/session.ts (250-295); packages/e2e/src/env.ts (grep)
- packages/e2e/native/ios/Sources/warden-simd/{main,Arguments}.swift, Device/Session.swift (grep for resources)
