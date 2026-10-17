# warden e2e stack: performance and robustness audit (2026-10-16)

Scope: the code added by #15, #22, #21, #25, #30 and #26 at commit `dfcc68b`: the `@delacour/warden-e2e` runner and drivers, the `warden-simd` Swift helper, the `warden-uiad` Java server, `warden ui`, the `warden e2e` orchestration in `apps/cli`, the lease, boot and build code in `packages/core`, and the benchmark. Method: 21 scoped read-only agents (one improvement goal each, disjoint file ownership), then two independent skeptic agents per P0/P1 finding, then the orchestrator's own reading of the cited lines for the top items. No source file was changed. Raw material: `docs/audit/raw/<nn>-*.md` (one per agent, full evidence), `docs/audit/verify/p0p1-verdicts.md` (the skeptic verdicts), `docs/audit/BRIEF.md` (rules, rubric, known items K1–K18).

Environment limit: the audit ran in a Linux container with no simulators, emulators, `xcrun`, `adb` or Swift toolchain. Every impact figure is either **measured** (quoted from `docs/bench/*-2026-10-16-perf.md` or a plan table) or **estimated** (arithmetic shown in the raw finding). 116 of the 263 findings name an on-device check that would settle them; the highest-value ones are listed in section 7.

## 1. Executive summary

- **263 findings** across 21 tracks: after the skeptic pass, 13 verified P1 (three of them P0 on a fresh checkout or after an idle gap) plus 3 test-suite P1 from agent 21 checked by the orchestrator, 160 P2, 87 P3. 208 are new; 45 extend a known item from the previous perf pass; 5 claims that a fix had landed did not hold (`claimed-fixed-not-landed`).
- **Nothing in the Top tier was refuted.** The two skeptic lenses confirmed the mechanism of all 40 P0/P1 findings (31 fully, 9 partly) and lowered the severity of 30 of them under the rubric, mostly because the trigger is rare or a workaround exists. Section 2 lists what survived at P1.
- **The build cache cannot fill on a fresh checkout** (17-1, 17-2, K8). `expo prebuild` moves the native fingerprint during the first build and `runLocalBuild` refuses to cache; a build that Gradle or Xcode finds up to date leaves an artifact older than the build start, which `locateArtifact` discards. The bench's first two Android runs died on this. Both fixes are small, and both need a guard against picking another worktree's `.app` (17-3).
- **Warm reuse is lost on the "first run after 20 minutes"** (16-1, 12-2). Every claiming command spawns a detached `warden gc` right before it claims; gc snapshots the lease table once and shuts down idle booted devices without re-checking, so it can take the device the claim is about to reuse. iOS then re-boots (6.5 s, measured for a second boot) and Android starts a whole new emulator. Two agents found this independently.
- **A failed or slow helper warm-up costs 2.2 s per test for the rest of the run** (20-1, 14-1, 14-2, 03-1). Jobs that get no socket spawn their own `warden-simd` on stdio beside the resident one; two quiescence streams on one simulator push every `settle` from ~258 ms to 2.4–2.9 s (measured in the perf plan). The helper spawn, stop and reconnect paths have no arbitration between them.
- **Android `app.open()` cannot work with Metro today** (09-5): the Android driver refuses any launch args, and `app.open` always forwards `WARDEN_LAUNCH_ARGS`, which the dev-client path fills with `--initialUrl`. Release-build suites are unaffected.
- **Two host-level bugs hide behind "flaky tests"**: `isPortFree` treats a code-less bind error on `::` as busy, so no port can be leased on a host without IPv6 (18-2; this is why 9 of the 11 baseline test failures here fail), and `warden affected` silently drops untracked files when `warden.config.ts` lives in a subdirectory, which is this repo's own layout (18-1, reproduced).
- **Where the remaining wall time is on iOS** (bench, per 8-test rep): 8 launches 12.8 s, 17 `typeText` 18.7 s (the pacing floor; do not lower, K9), 170 snapshots 13.0 s, settle 2.6 s. The structural savings the audit found are the assert-then-tap double snapshot (06-2, 07-2: 1.6–3.4 s per rep, estimated), guest recycling moved off the launch path (03-4: up to 1.9 s per rep, estimated) and a first-content-gated launch wait (09-1, K15). On Android the equivalents are `monkey` launches that return before the first frame (05-4), the 80 ms edit-quiet paid after every key (04-5: ~1.2 s per rep) and the launch-screen settle (K15: 4.8 s per rep measured, overlapping boot).
- **Cold boot** (section 4): iOS pays 2 spawns to reuse a booted sim and 6.5–11.9 s plus probe, hide, `AutomationEnabled` and slim to boot a cold one; Android pays 20–45 s with no warden-owned quick-boot snapshot and two races around emulator registration. The policy levers (snapshot ownership, keep-booted window, `/clear` semantics) are the user's call and are listed as questions in section 9.
- **The CLI binary carries `typescript` (27.9 MB of 116 MB, measured) for one hidden subcommand**, and `run`/`dev`/`app` still load zod config schemas at start (+12.6 MB RSS, measured in source mode) (15-1, 15-2, K3, K4).

## 2. Top tier: findings that break, flake or hold a run (verified)

Severity is the skeptics' merged verdict; "author" is what the finding's agent assigned. The three author-P0s are shown first: one lens kept each at P0, the other said P1 because a workaround exists or the trigger is one specific state; both agreed the mechanism holds and the trigger is a normal workflow (fresh checkout, first run after idle).

| # | ID | Verified | What happens | Fix shape | Effort | Device? |
|---|---|---|---|---|---|---|
| 1 | 17-2 | P1 (author P0) | `locateArtifact` keeps only outputs newer than the build start. An up-to-date Gradle or XCBuild run leaves the old mtime, so a successful build reports "no Release .apk/.app was found" and every later run repeats it until the artifact is deleted (measured: bench runs r1/r2). | Accept the newest candidate when the build exit code is 0 and the post-build key equals the requested key, excluding `androidTest` APKs and other DerivedData projects (17-3). | S | iOS half only |
| 2 | 17-1 | P1 (author P0) | On a fresh checkout `expo prebuild` creates `ios/`/`android/` mid-build, the native fingerprint changes, and `runLocalBuild` refuses to cache. Re-keying alone still rebuilds for the second device in the same run and for every other worktree. | Cache under the requested key and alias the post-build key when the JS key is unchanged and the native dir did not exist before the build (question 9.4). | M | no |
| 3 | 16-1 / 12-2 | P1 (author P0) | `maybeAutoGc` spawns a detached `gc` right before the claim; gc reads `plan.leased` once and shuts down idle booted devices without re-checking under a transaction. The first run after 20 min idle loses its warm device and can be handed one that is mid-shutdown. | Re-check the lease inside the shutdown loop under `store.transaction`, and skip the auto-gc spawn when the caller is about to claim (run it after the claim). | S | timing only |
| 4 | 20-1 | P1 | When warm-up fails or is skipped, every iOS job spawns a stdio helper beside the resident socket helper; two quiescence streams make each `settle` take 2.4–2.9 s instead of ~258 ms (+2.2 s per test, estimated from measured settle times). | Pass the resident socket to jobs even when the warm snapshot failed, and never spawn stdio when `$WARDEN_HOME/simd/<udid>.sock` answers. | S | frequency |
| 5 | 09-5 | P1 | Android `launch` returns `E_UNSUPPORTED` for any args; `app.open` always forwards `WARDEN_LAUNCH_ARGS`, so every dev-client (Metro) `app.open()` on Android fails. | Translate `--initialUrl <url>` into `openUrl` on Android, or strip args there. | S | no |
| 6 | 18-2 | P1 | Any bind error without `EADDRNOTAVAIL`/`EAFNOSUPPORT` is "busy"; Bun reports a code-less error on `::` where IPv6 is absent, so `claimPorts` finds no free port. Reproduced by the baseline tests here. | Treat an unknown error on the `::` probe as "unsupported" (skip), or probe v6 only when `/proc/net/if_inet6` exists. | S | no |
| 7 | 18-1 | P1 | `git diff` paths are repo-root-relative, `git ls-files --others` paths are cwd-relative; with `warden.config.ts` in a subdirectory the untracked files vanish from `warden affected` (reproduced). | Prefix untracked paths with the config dir relative to the toplevel. | S | no |
| 8 | 16-2 | P1 | A device that never gets ready (iOS `bootstatus` 300 s, Android `boot_completed` never 1) is not quarantined or retried; booted devices rank first, so the next claim waits another 5 min on it. | Quarantine on ready-timeout as the health probe already does on failure. | S | no |
| 9 | 20-2 | P1 (partly) | The SessionEnd hook (including `/clear`) releases a still-running `warden e2e`/`batch`'s leases and stops its helpers; `holdLeases` ignores that `store.heartbeat` updated 0 rows, so the run continues on devices it no longer holds. Whether Claude Code keeps a background run alive across `/clear` was not confirmed here. | Abort the run when the heartbeat updates fewer rows than leases; decide the hook policy (question 9.3). | S | no |
| 10 | 05-1 | P1 | On Android 11+ permission prompts no label matches `ACCEPT_BUTTONS`, so `alert("accept")` falls back to the last button, which is "Don't allow". Button ids are not in any fixture here. | Capture a dump per API level and add the ids; prefer id over position. | S | yes |
| 11 | 11-2 | P1 | Replay's landmark check turns a moved element into "absent", so `is hidden` and `wait hidden` pass falsely and `wait visible` burns its timeout. | Distinguish "moved" from "absent" in the chain resolver. | M | no |
| 12 | 10-1 | P1 | A devtools session that loses its Metro target for ~2 s is dead for the rest of the spec process; a relaunch takes 4.5–6.4 s, so every post-relaunch devtools call fails. | Re-resolve the target on demand with a bounded wait. | M | yes |
| 13 | 12-2 | P1 | Same race as 16-1, seen from the supervisor side. | Same fix. | S | timing only |

Verified P2 after the skeptic pass, high leverage on the time budget: 03-1 (socket client never reconnects after a lost daemon; one death fails the rest of the spec process), 14-1/14-2/14-3 (helper spawn, ready and stop paths race each other and leave a second helper or an orphan), 06-1/07-1 (a tap aims from one fresh snapshot with no stability check; the mis-tap race of `wdn-perf.md:96` is narrowed, not closed), 09-2 (`systemAlerts: "dismiss"` cancels the "Open in…?" sheet from inside `openLink` and poisons the no-sheet memo), 08-1/08-2 (a timed-out body or hook keeps driving the device during cleanup and into the next test; post-deadline work is not bounded by bun's 30 s margin), 04-1 (one transient `connect_failed` permanently disables `warden-uiad` on that serial), 17-4 (N devices run N independent `ensureApp`s; failing builds repeat N times), 16-3 (no warden-owned Android quick-boot snapshot), 16-4 (emulator registration race), 15-1 (typescript in the binary).

## 3. Where the time, CPU and memory go (what the audit adds to the bench numbers)

**iOS flow time.** The bench's per-rep decomposition (8 launches 12.8 s, 17 `typeText` 18.7 s, 170 snapshots 13.0 s, settle 2.6 s) leaves three structural targets. (a) Assert-then-tap is two snapshots per pair, about 45 pairs per rep; a snapshot stamped as quiet by the helper could serve the following action (06-2, wire change) or a ~10 ms hit-test could prove the target still sits where the kept snapshot said (07-2): 1.6–3.4 s per rep, estimated. (b) Guest recycling runs inside `rebind` after `simctl launch` returned (11 of 24 launches, +0.51 s each, measured); it could overlap the launch (03-4): ≤ 1.9 s per rep. (c) The launch wait: `app.open({ wait: "quiet" })` reaches quiet on the static launch screen because the stream measures the main run loop and Core Animation only, so its 325 ms per launch is overlapped boot time and buys no "first screen ready" guarantee (09-1, 01-7, K15); a first-content-gated wait or `wait: { until }` gives the guarantee the following tap needs. The 76 ms average snapshot cannot be split today: the helper's `ms` excludes encode and write and the TS driver drops `readMs` (02-3). Per-RPC costs that were checked and found cheap: the tracing `Proxy` and `AsyncLocalStorage` (one Map lookup, one span object), the NDJSON splitter, zod on replies (element trees go through a hand-written validator; two small envelope parses remain, 03's K-note), the screen and query layer (< 1 ms per read, 06-10).

**Android flow time.** `warden-uiad` made snapshots cheap (p50 25 ms); what remains is `monkey` launching a JVM per launch and returning before the first frame (05-4: `am start -W -n` is cheaper and waits for the frame), the 80 ms edit-quiet paid after every `typeText`/`key` even when the fill's own confirm reads cover it (04-5: ~1.2 s per rep), the launch-screen settle (K15: 4.8 s per rep measured, overlapping boot), per-`getChild` round trips into a busy UI thread behind the ~270 ms p95 after navigation (04-4), and `clearCache()` being a silent no-op below API 34 (04-3, K6).

**Host CPU and RSS.** The bench's host numbers cannot yet be read as rates: `ps %cpu` on macOS is a lifetime/decayed average (19-5), the resources series averages prepare, teardown and housekeeping with the runs (19-6), and there is no per-process split (K2, 19-7). The supervisor's own share is small: the poller is already byte-offset, frames run at 1 Hz, and the parent's work is about 0.3 % of a core (13-4, estimated); its remaining costs are three parses of every results line and an uncached `realpathSync` per result × flow (13-5), `writeSync` per child chunk (13-6), and an inline failure screenshot that holds a worker for up to 5 s and duplicates the runner's own `failure.png` (13-2). The helper's idle cost is a 100 ms and a 200 ms poll (02's K-note), negligible. On the device, `warden-uiad` is ~143 MB RSS (measured) with per-node allocations in the JSON writer (04-8). The binary is 79.5 MB of bun plus 35.8 MB of payload, 27.9 MB of which is `typescript` for `__affected-graph` (15-1, measured); `run`/`dev`/`app` load +95 modules and +12.6 MB through the zod config schemas (15-2, K4), with no startup-test guard for those commands (15-3).

**Memory and leaks on the spec side.** Devtools rings (console 500, network 2000 entries, bodies < 64 KB) are never cleared per attempt (K14, 10-9, 08-6); retries share one attempt dir so a passed result lists the failed attempt's screenshots and `trace.jsonl` concatenates attempts (08-3); the React-tree accelerator walks and measures the whole screen on every poll miss on a dev client, about 25 % of the app JS thread while waiting (10-3, estimated).

## 4. Cold boot of iOS simulators and Android emulators

Agent 16's per-step map (its `## Gaps` section has the full table with the spawn-cost assumptions and the on-device commands to replace each estimate). C = on the critical path to the first test.

| Path | Step | Cost | Basis | C |
|---|---|---|---|---|
| iOS warm reuse | `simctl list` + `launchctl list` | 2 spawns, 300–500 ms | est | yes |
| iOS shut-down pool sim | `simctl boot` + `bootstatus -b` | 6.5 s (second boot) | measured | yes |
| | health probe, 2 parallel `simctl spawn launchctl` | 150–300 ms; worst case 20 s (5 s then 15 s retry) | est | yes |
| | headless hide with windows open | 1.0–1.5 s, plus 6.5–11.9 s per sim it reboots, serially, inside the claim | est | yes |
| | `AutomationEnabled` write (fresh clone; golden never sets it) | 300–500 ms | measured | on `ui`/warm paths |
| | slim (74 `launchctl` spawns, 8 wide) | 1.6–2.7 s | est | yes |
| | helper cold start | 544–726 ms (708 bench) | measured | overlaps install |
| | first app launch | 4.5–6.4 s | measured | yes |
| iOS pool growth | `readGoldenTarget` 3 serial spawns incl. `xcodebuild -version`, before the lock | 0.4–1.4 s | est | yes |
| | `simctl clone` under the `golden:ios` lock, serialised across N creates (2 s lock poll) | 3.7 s each | measured | yes |
| | boot of a fresh clone | 11.9 s; 3 in parallel ~20 s | measured | yes |
| | clone failure → `simctl create` first boot | 146–239 s | measured | yes |
| Android new emulator | `-list-avds` ×2, `adb devices` ×2 | 0.25–0.7 s | est | yes |
| | `boot` existence check 1.5 s after spawn | 20–50 ms, racy (16-4) | est | yes |
| | `wait-for-device` + `boot_completed` poll (new `adb shell` every 2 s) | 20–45 s boot + ~1 s poll slack | est | yes |
| | `warden-uiad` start | 76–128 ms | measured | yes |
| Android reuse | inventory + `wait-for-device` + one `getprop` | 100–200 ms | est | yes |

What the audit found on this path, beyond the map:

- **Reuse is defeated by timers and a race.** gc idles a booted warden device out after 20 min and stops its helper; the helper idle-exits after 10 min (cold 708 ms vs warm 182 ms, K11); the SessionEnd hook shuts down every device the session booted; and the auto-gc race (16-1) can remove the device during the claim. There is no `warden warm`. Agent 16-13 lists the options with their RAM cost per booted sim, unmeasured (question 9.2).
- **Android has no warden-owned quick-boot snapshot** (16-3). The emulator argv is `-no-window -read-only -no-snapshot-save -no-boot-anim`; snapshot *load* is left to whatever the user's AVD holds and save is off, so most new emulators cold-boot. A warden snapshot keyed by system image would save an estimated 15–40 s per emulator and give every run the same start state, at 2–4 GB disk per AVD and a one-time writable boot (question 9.1). `-gpu`, `-cores`, `-memory` and `-no-audio` are not set anywhere.
- **Two Android races on create**: the one-shot `adb devices -l` existence check right after launch (16-4: a miss fails the claim and leaves a running emulator with no lease), and `waitForBoot` polling a dead `adb shell` session for the full 30 s (05-3).
- **iOS: the headless hide is awaited inside the claim**, before `onLeased`, so install and warm wait on `osascript`, a fixed 500 ms sleep and a sequential reboot loop (16, 12-1: a late-window hide can also reboot a sim under an already-warmed helper and jobs still get its socket). The probe can false-quarantine a healthy sim under load (16-10). `simctl boot/clone/create/list` have no timeout; a wedged clone blocks every other clone for up to 40 min under the golden lock (16-11).
- **Golden clones do not inherit `AutomationEnabled` or the slim disabled set** (16-7, slim.ts:172-173), so every fresh clone pays both again.
- **The health probe re-does a cold boot up to three times** on probe failure (`MAX_HEALTH_RETRIES` 2); a device that never gets ready is never quarantined (16-2).
- **Throughput cap**: `max = cores/4 ≤ 4` is the regime guard that also keeps typing lossless (K9); the same load starves the probe (16-10, 16-16).

## 5. Deep dives by track

Each track's full write-up, with every citation, is `docs/audit/raw/<nn>-*.md`. The lists below are the agents' own Top 5 condensed, with the skeptics' verdicts applied.

**01 · iOS helper, settle and launch-bind.** A snapshot-fallback settle on a *booting* app passes the wedge test and ends healthy AX guests, and can answer `quiet` on the launch screen (01-2). `rebind`/`settle{bundleId}` ask launchd for the pid every 150 ms while the stream disagrees, although `simctl launch` already printed it (01-1: 40–120 ms per launch; question 9.6 asks whether the op may take a `pid`). The guest-recycle age is a constant 12 s checked only in `rebind`, so launch gaps of 10.5–12 s still wedge every other test and non-relaunching suites get no protection (01-3, K7). `start()` during `restart()`'s awaited teardown can open a second stream (01-4). The latched-stream back-off counts from the restart decision, not from when the new stream opened, so under load a restarted stream is cut off before it attaches (01-5).

**02 · iOS helper I/O and wire.** A hung self-timed op pins `IdleTracker`, so a resident helper never idle-exits (02-2). The 13 s per rep snapshot bucket cannot be split: the helper's `ms` excludes encode and write, the driver drops `readMs`/`ms`/`nodes`, and `log` events never reach socket clients (02-3). Response writes are blocking `write(2)` calls with no send timeout on an 8 KB default unix-socket buffer (02-1). The wire is pinned for element payloads only, and `fake-simd.ts` drifts from the Swift server in five places, so tests can stay green while a device fails (02-6). An encode failure answers `id: null`, which the client discards, so the caller waits out its full timeout (02-4). Confirmed cheap: encoding (0.3–2 ms per snapshot, estimated), the idle polls, key pacing defaults.

**03 · iOS TS driver.** The socket client never reconnects after the daemon connection drops; `E_HELPER_CRASHED` is retryable, so every later look polls for its full 30 s action timeout (03-1, P2 after verification: the trigger is a daemon death mid-run, question 9.7). Guest recycling sits on the launch critical path (03-4). A live socket that sends no `ready` costs 15 s and then a second stdio helper (03-2). Bridge-stale recovery in socket mode shuts the shared daemon down, so the rest of the run pays cold starts (03-3). An aborted driver call is never cancelled in the helper, so an in-flight `typeText`/`swipe` keeps sending HID events into the next test (03-6).

**04 · Android `warden-uiad`.** Any connect failure that is not "busy" is persisted as `uiadUnsupported` and turns the server off for that serial until the dex changes (04-1, P2 after verification: frequency unknown). `uiad-ops` stops a healthy server on any non-refusal error, and each restart counts toward the "more than 4 starts" give-up (04-2). Every `typeText`/`key` pays the full 80 ms edit-quiet (04-5). `clearCache()` is a no-op below API 34 (04-3). The busy rule kills any `warden-uiad`, including one a live warden process is using, so two drivers on one device take turns killing each other (04-6, 20-6; question 9.8). Checked and clean: buffered stdin, `System.out` redirected, `send` never under `eventLock`, reflection cached once, JSON escaping correct, single-flight start.

**05 · Android TS driver.** `alert("accept")` presses "Don't allow" on Android 11+ permission prompts (05-1, P1). `monkey` starts a JVM per launch and returns before the first frame (05-4). The animation guard restores scales when any driver closes, so a `warden ui` call during an e2e run turns animations back on under it (05-2). `waitForBoot` keeps polling a dead shell session for 30 s (05-3). A transient `null root node` makes the dumper probe every route, about 4.8 s instead of 1 s (05-5). Verified landed: the 1 s `elementAtPoint` cache is gone; open is 2 round trips.

**06 · Screen query and observation cache.** Actions aim from one fresh snapshot with no stability check (06-1, P2 after verification; question 9.9 on the fix shape). Assert-then-tap is two snapshots, ~45 pairs per rep (06-2). On a dev client the React tree is read on every no-match poll of every `getByTestId` action (06-4). The reuse window is per platform, not per read cost: Android keeps snapshots 1 s while a `warden-uiad` read costs ~50 ms (06-7). An Android alert press can aim from a kept snapshot up to 1 s old (06-6). Verified landed: lazy subtree text, lazy excerpts, the PERF-2.1 cache rules, `locator.read()`.

**07 · Screen actions and polling.** `tap({ until })` re-sends blind after a fixed 4 s window, so a late-landing press is pressed again and a dropped press costs 4 s where 1 s would do (07-3; question 9.10). No frame-stability check before a tap (07-1). A ~10 ms hit-test could replace the second snapshot of assert-then-tap (07-2: ~1.6 s per rep). After the deadline aborts, `fill`'s confirm loop keeps running with zero-length sleeps (07-4). Secure fields are never read back although the bullet count is parsed (07-6). Not landed: PERF-2.3's early end of the negation grace (07-8) and PERF-3.3's `setText` fill (07-10).

**08 · Runner and session.** A timed-out body or hook keeps running and drives the device during cleanup and the next test, writing taps into that test's trace (08-1, P2 after verification: needs a swallowed timeout or non-signal-aware work). Post-deadline work (3 × 10 s captures plus 10 s per hook) is not bounded by bun's 30 s margin, so bun starts the next test while the old cleanup runs and `leaveAttempt` wipes the new attempt (08-2). Retries share one attempt dir (08-3). Failure capture is serial and never cancelled, up to 30 s on a wedged device (08-5). `beforeAll`/`afterAll` run with no deadline, trace or capture, and a throw writes zero results lines (08-4).

**09 · Device and app launch.** With `systemAlerts: "dismiss"`, a locator read presses Cancel on the "Open in…?" sheet, including the `until` read inside `openLink`; the scheme is then remembered as sheet-free (09-2). Android `app.open()` fails with any launch args (09-5, P1). `wait: "quiet"` goes quiet on the launch screen (09-1, K15). `app.open({ url })` on iOS calls raw `openUrl` with nothing answering the sheet (09-4). Alert-read retries count attempts, not time: one wedged helper turns one `device.alert` into up to 15 × 10 s (09-6). Verified landed: PERF-1.3, PERF-1.4, PERF-2.4.

**10 · Devtools facet.** A session that loses its target for ~2 s is dead for the rest of the process (10-1, P1). The network drain is destructive and shared, and re-install ignores new config (10-2). The React-tree accelerator walks and measures the whole screen on every poll miss (10-3). The Android target filter uses the AVD name while Metro reports `Build.MODEL` (10-4). `evaluate`, `tree` and `reloadJs` wait out a reconnect with no deadline (10-5). Rings never cleared per attempt (K14).

**11 · Flows record, replay, export.** The landmark check turns "moved" into "absent" (11-2, P1). Recorded `type` and `key` steps always export as a `FIXME` throw (11-1). The append lock gives up at 5 s but treats a lock as stale only at 10 s, so a killed recorder drops steps (11-3). `record start` can erase the helper record a concurrent connect wrote (11-4, P3 after verification: the helper is found by its socket path). Replay takes two snapshots per `is|get|wait` step (11-5). The 2.4 s per step figure in the e2e plan was a dump-driver number under heavy load (known-stale).

**12 · `warden e2e` setup.** The auto-gc race (12-2). A late-window hide can reboot a sim under a warmed helper (12-1). Three global barriers (setup, open/hide, `settleWarm`) let the slowest device on any leg gate every job on every leg; a wedged helper costs up to 120 s and warden's own `openOnDevices` launch has no timeout (12-3, 12-6). Slim sits behind the Metro await and the installs although it needs only a booted device (12-4). The Metro prewarm cannot be aborted, up to 2 × 5 min on Ctrl-C (12-5). Verified landed: early warm at `onLeased`, hide ∥ open, legs in parallel, `READY_POLL_MS` 150, device isolation default, `idle` shutdown locally.

**13 · `warden e2e` observe.** The TUI frame timer and hidden cursor are not cleaned up when `runGrid` throws (13-1). The failure screenshot is awaited inline, duplicates `failure.png` and shows the end of the shard (13-2). `--record` counts an early-exiting recorder as started and never notices a mid-run death (13-3). No bench or test measures the parent process (13-4). Results lines parsed three times, uncached `realpathSync` (13-5). Verified landed: byte-offset poller, 1 Hz frames; not landed: child-side stamping.

**14 · `warden ui` agent CLI.** `ensureHelper` gives up at 5 s and leaves its spawned helper running, so the warm path runs cold and collides with it (14-1). A helper that accepts but sends no `ready` within 2 s is taken for silence and a second one is spawned (14-2). `stopHelper` has no arbitration (14-3). Android pays per call for a shell, a probe, 6 `settings` calls, a dex check, a `warden-uiad` start, a stop and 3 `settings` restores, with animations flipping back on between calls (14-8, K17). Helper reuse is defeated whenever the owner key changes, e.g. `user:<ppid>` from `bun run` (14-5; question 9.11). Two assumptions in the brief were wrong and are corrected in 14's K-notes (no 2 s cold-connect penalty; `state.json` is not rewritten per snapshot).

**15 · CLI startup and size.** `typescript` in the binary for one subcommand (15-1, 27.9 MB measured; question 9.12). zod through `ensure.ts`/`dev.ts` on `run`/`dev`/`app` (15-2). The npm shim uses `spawnSync` and forwards no signals, so a SIGTERM orphans a running `warden run` and its leases (15-4). `startup.test.ts` guards no allowlist for `run`/`dev`/`app`/`hook`/`ls`/`devices`/`check`/`port` (15-3). Root `--help` imports all 28 commands (15-5). Verified landed: lazy ora/clack, per-command lazy load, `compileArgs` flags.

**16 · Cold boot and leases.** Section 4.

**17 · Builds and install.** Section 2 items 1–2 and 17-3. N devices run N `ensureApp`s with no single-flight (17-4). The fingerprint memo promised by PERF-4.6 never landed, so `@expo/fingerprint` runs on every ensure, seconds per run, now on the critical path when sims are warm (17-5). Android never checks that the installed app is warden's build (17-6); `eas-cli` calls and the APK download have no timeout while holding the build lock (17-8); the cache is never pruned automatically (17-11; question 9.13). The `.md` has the spawn-count table for `app ensure` per platform and cache state.

**18 · Store and affected.** 18-1 and 18-2 (section 2). The import graph is built even when a `runAll` glob already selected every flow (18-3: ~410 ms measured here); a cold walk costs ~400 ms and is paid again after every edit (18-4). A crashed `warden run`/`dev` keeps its device and ports for the 30 min TTL because a dead pid with a fresh heartbeat counts as alive (18-5; question 9.14). A blocked `BEGIN IMMEDIATE` freezes the process for 15 s then throws inside the heartbeat timer (18-6). The store itself is fine: WAL, `synchronous=NORMAL` landed, cold open 12.6 ms, warm 0.33 ms, empty transaction 0.011 ms (measured here).

**19 · Bench and suites.** `ps %cpu` is not a rate on macOS (19-5) and the resources series mixes phases (19-6), so K12's CPU numbers cannot be compared across suite lengths. `realExec` is not bounded by its timeout when a grandchild holds the pipes (19-1: the best candidate for the K13 flake; `exec.test.ts` fails here). The load gate runs before the app build and only once (19-3). The bench lease uses the 5-minute agent TTL and is never heartbeated (19-2; question 9.15). The untraced-time computation is correct for what it claims (K1).

**20 · Cross-cutting risk.** 20-1 and 20-2 (section 2). `stopHelper`, `video stop` and `logs stop` signal a pid from `state.json` with only `kill(pid, 0)` as identity check, so after a crash or reboot a reused pid can belong to an unrelated process (20-3). Two Android drivers on one serial kill each other's `warden-uiad` as "stale, ours" until both fall back to the dump (20-6). A `WARDEN_SIMD_SOCKET` inherited from the parent environment reaches the jobs of devices that did not warm, and the helper's `ready.udid` is never compared with the device, so those jobs drive another simulator (20-8).

**21 · Unit-test suite speed.** `bun test` per package was measured here, serial against `--parallel=4`: cli 55.9 s to 34.5 s, core 15.0 s to 7.9 s, e2e 9.3 s to 3.3 s, with identical pass and fail counts, so `--parallel` is the measured gain (21-2); it should land after the thin wall-clock margins are widened (21-8: `ui close` asserts under 2.5 s against a 2 s real wait and took 2.10 s here). `commands/e2e.test.ts` builds a git repo in `beforeEach` and again in `resuite` for 72 of its 96 tests, 1,310 git spawns and 13–18 s of its 22.8 s, and it sets the cli critical path (21-1). The 11 container failures are one root cause plus two mismatches and one real gap: the 8 cli port tests and the core `isPortFree` test are 18-2, with the three `invalid port "NaN"` messages a cascade from an empty `claim` stdout (21-4); `doctor` expects a `sim-helper` row that `doctor-helper.ts` emits only on darwin (21-5); the bench `realExec` timeout test orphans `sleep` under dash so `drain` waits the full 5 s, which is the 19-1 mechanism seen from the test (21-6). CI runs `bun run test` only on macOS, so Linux-only failures never show (21-7). Also: `declarations.test.ts` emits the same declarations twice, about 3 s (21-3); `helper.integration.test.ts` carries about 3.4 s of real waits from constants the tests cannot inject (21-9); the affected tests spawn a real worker per case (21-10); the `help.test.ts` snapshot is 85 KB (21-11); a bare `bun test` in `packages/e2e-bench` picks up the Detox suite and fails 8 tests (21-12). Agent 21's three P1s were checked by the orchestrator against the files and the baseline, not by the skeptic pass.

## 6. Suggested implementation waves

Each item links to its finding; "device" marks work that needs a simulator or emulator to verify before merging.

**Wave 1 (no device needed, small or medium, high confidence).** 17-2 guarded artifact fallback and 17-3 DerivedData scoping; 17-1 cache under the requested key (after question 9.4); 16-1/12-2 lease re-check under transaction in gc and auto-gc after the claim; 16-2 quarantine on ready-timeout; 16-4 wait for adb registration; 20-1 and 14-1/14-2/14-3 helper lifecycle arbitration (one spawner, pass the socket on warm failure, never stdio beside a live socket, stop under the same arbitration); 03-1 reconnect once in socket mode; 20-2 abort on a zero-row heartbeat; 09-5 Android launch args; 18-1 path prefix; 18-2 IPv6 probe classification; 11-2 moved vs absent; 17-4 single-flight `ensureApp`; 04-1 do not persist transient connect failures; 08-1/08-2 attempt-scoped session view and one cleanup budget inside bun's margin; 10-1 bounded target re-resolve; 15-3 startup-test guards for `run`/`dev`/`app`; 13-2 drop the duplicate inline screenshot; 19-1 process-group kill in the bench exec.

**Wave 2 (device-verified changes).** 09-1 first-content-gated launch wait or `wait: { until }` (K15); 06-1/07-1 stability check before a tap and 07-2 hit-test instead of the second snapshot; 07-3 `tap({ until })` reacting to a visible change instead of a fixed 4 s window; 03-4 guest recycle before `simctl launch`; 01-1 pass the launch pid to `rebind`; 01-3 recycle age tied to the launch gap; 02-3 export `readMs`/`ms`/`nodes` and forward `log` events; 04-5 skip the edit-quiet when the caller confirms; 04-4 prefetch strategy for `getChild`; 05-4 `am start -W -n`; 05-1 permission button ids per API level; 12-3 per-leg barriers and a timeout on `openOnDevices`; 12-4 slim at `onLeased`; 16 hide out of the claim's critical path and a parallel reboot loop; 16-7 set `AutomationEnabled` and the slim set in the golden; 17-5 fingerprint memo; 14-8/20-6 a resident `warden-uiad` per lease with store arbitration; 19-5/19-6/K2 CPU-seconds per rep and a per-process split in the bench.

**Wave 3 (policy; the user's call, section 9).** Android warden-owned quick-boot snapshot and emulator flags (16-3); keep-booted window or `warden warm` (16-13); `/clear` semantics for running runs (20-2); helper replacement on owner change (14-5); `wait: "quiet"` meaning (09-1b); `typescript` out of the binary (15-1); wire additions for a quiet stamp (06-2) and read timings (02-3); CI emulator matrix for API 30–36 (K6).

## 7. What needs a device, and the exact checks

The raw files list 116 device-dependent checks. The ones that would change a recommendation:

- **16-1**: a pool sim idle > 20 min, then `WARDEN_DEBUG=1 warden e2e example`; watch `xcrun simctl list devices | grep Booted` once a second during the claim and whether the gc child issues `simctl shutdown`.
- **20-1 / 14-1**: `warden e2e example --platform ios` five times from a cold boot; `grep "not warm" logs/warm-*.log`; `ps -axo pid,command | grep 'warden-simd --udid'` (expect one per sim); spec logs for `spawning a helper on stdio instead` and `via:"snapshot"`.
- **17-2 iOS half**: build twice, then `stat -f %m …/Release-iphonesimulator/example.app` to see whether an up-to-date XCBuild touches the `.app` mtime.
- **09-1 / K15**: trace `device.settle` end against the first `read.isVisible` that sees `welcome.screen` per launch, both platforms.
- **06-1 / 07-1**: log each tap's target frame against the previous look's frame during `bun run bench run --frameworks warden --runs 3` at host load above 15; count taps whose frame moved.
- **16-3**: time a cold `emulator -read-only -no-snapshot-save -no-window -no-boot-anim` boot to `boot_completed`, then the same from a saved snapshot (`adb emu avd snapshot save`, launch with `-snapshot`), on the 16 KB image too.
- **05-1**: grant a permission on API 30, 33, 34 and 37 and capture `adb exec-out uiautomator dump /dev/tty` for the button ids.
- **04-1**: start `warden-uiad` 20 times right after `boot_completed=1` on a cold emulator and collect every `fatal` that does not say "already registered".
- **02-3 / snapshot split**: after exporting `readMs`, compare helper read time with the 76 ms average per snapshot in a bench rep.
- **19-5**: `ps -o %cpu,time -p <pid>` once a second on a process that goes idle then busy, to confirm the macOS semantics before trusting any CPU average.
- **Spawn costs** behind every estimate in section 4: `hyperfine -w 2 'xcrun simctl list devices available -j' 'xcrun simctl spawn <udid> launchctl list' 'xcodebuild -version' 'emulator -list-avds' 'adb -s <serial> shell getprop sys.boot_completed'`.
- **RAM per booted sim and emulator**, for the warm-pool decision: `footprint -p <launchd_sim pid> --all-children` and `footprint qemu-system-aarch64` for 1, 3 and 4 devices booted idle, with and without slim.

## 8. Known items after the audit

K1 untraced time: the computation is right (19); the residue is poll sleeps, hooks and the lazy driver open in each process's first test (08-7); partly stale since the idiomatic suite. K2 per-process RSS split: still missing; it is also what would attribute the parent's share (13-4, 19-7). K3 binary size: 27.9 MB is `typescript` (15-1). K4 eager zod: exact chain and cost (15-2), guard missing (15-3). K5 static sharding: confirmed in `bun-runner.ts`; `batch/schedule.ts` is a dynamic FIFO, so the static part is the shard assignment, and retries run on the same worker (18-7). K6 API 37 only: `clearCache` is a no-op below 34 (04-3); fixtures are API 37 only (04-9); the dump fallback paths carry their own bugs (05). K7 wedge: three more ways to disturb the guest found (01-2 reap on a booting app, 20-1 second stream, 20-9 Resources swapped under a live helper); the recycle threshold is a constant (01-3). K8: both bugs confirmed with lines and a fix shape (17-1, 17-2). K9 pacing: untouched, confirmed as the floor; the TS budget ignores the env overrides (03-5). K10 slim refusal on Android: confirmed (12-8). K11 cold prepare: residency is also lost to gc, SessionEnd and the race (16-13). K12 CPU: cannot be read as a rate (19-5, 19-6); the parent is not in it (13-4). K13 flake: best candidate `exec.test.ts` "times out" (19-1). K14 rings: confirmed, plus the shared attempt dir (08-3, 08-6). K15 launch settle: mechanism found (01-7, 09-1, 05-4). K16 launch timeout: warden's own `openOnDevices` launch has none (12-6); `boot/clone/create/list` have none (16-11). K17 Android per-call cost: the full per-call bill (14-8) and the cross-process kill (20-6). K18 settle after relaunch: now runs only when `rebind` did not bind (03, 09-7); the lookup cadence during boot (01-1).

Plan claims verified as landed: PERF-1.3, 1.4, 2.1, 2.2, 2.3 back-off, 2.4, 4.3 (partly), 4.4, 4.5, 4.7, 4.8, 5.1 (poller and frames), 5.2, 5.3. Claimed fixed, not landed: PERF-2.3 negation early end (07-8), PERF-3.3 step 6 `setText` fill (07-10), PERF-4.6 fingerprint memo (17-5), PERF-4.4 artifact identity at build time (17-7), PERF-5.1 child-side log stamping (13-6).

## 9. Questions for the user

Each has the default the report assumes when it recommends.

1. **Android quick-boot snapshot** (16-3). Should warden own a per-AVD snapshot and launch from it by default (faster, identical start state, 2–4 GB disk per AVD, one writable boot), or keep it opt-in? Default assumed: opt-in config first.
2. **Warm pool** (16-13, 16-9). (a) a longer keep-booted window (hours, at an unmeasured 1.5–3 GB per sim), (b) an explicit `warden warm`, or (c) today's 20 min plus the race and SessionEnd fixes only? Default: (c) now, (b) proposed.
3. **`/clear` semantics** (20-2). Should SessionEnd on `/clear` release leases a still-running `warden e2e`/`batch` holds? Default: no; abort the run on a zero-row heartbeat regardless.
4. **Caching a CNG build under its pre-prebuild key** (17-1). Acceptable on the assumption that prebuild output is a pure function of the config inputs? Default: yes, with the alias.
5. **Which track first**: the Wave 1 correctness and flake items, or the Wave 2 wall-time items? Default: Wave 1.
6. **`rebind`/`settle` taking a `pid`** from `simctl launch` (01-1): an additive wire change. Default: additive, yes.
7. **Daemon death mid-run** (03-1): have you seen it (crash, `warden ui close` from another shell, idle exit between processes)? It decides P1 vs P2; the fix is cheap either way.
8. **`warden ui` during `warden e2e` on the same device** (04-6, 05-2, 20-6): a supported workflow, or should the CLI refuse it? Default: refuse with a clear message until a resident per-lease server exists.
9. **Tap stability check** (06-1): a Playwright-style check costing up to one extra ~76 ms snapshot on taps right after an input, or wait for the helper's quiet stamp (06-2, a wire change)? Default: the check now, the stamp later.
10. **`tap({ until })` re-send** (07-3): refuse to press again once the screen visibly reacted? Default: yes.
11. **Helper replacement on owner change** (14-5): should `user:<ppid>` churn from `bun run` scripts count as a hand-over? Default: no; key on binary and env.
12. **`typescript` out of the binary** (15-1): may `warden affected` require `typescript` in the analysed project? Default: yes, with a clear error.
13. **Build cache pruning** (17-11): auto-prune to 20 GB after each store, or only from `warden gc`? Default: gc.
14. **Dead pid with a fresh heartbeat counts as alive** (18-5): product decision or accident? Default: shorten for supervised leases.
15. **Bench lease owner** (19-2): is the bench started from an agent session or a user shell? Default: user shell; heartbeat anyway.
16. **CI**: add an Android emulator matrix (API 30–36) and an iOS smoke on macOS runners? Default: proposed, not added.
17. **Report placement**: `docs/audit/` committed in PR #31 with the raw files, or scratch only? Default: as committed.
18. **Follow-up implementation** as another multi-agent wave overnight, and with which agent count and model? Default: wait for the answer.

### Decisions recorded

Answers from the interview, in the order they were given. Each row says what changes in the plan above.

| Round | Question | Answer | Effect on the plan |
|---|---|---|---|
| 1 | 9.5 Which track first | Wave 1: correctness and flake fixes | Wave 1 (section 6) is the first implementation batch; Wave 2 wall-time items follow. |
| 1 | 9.1 Android quick-boot snapshot (16-3) | **On by default** | Differs from the report's assumed opt-in. When 16-3 lands, warden owns a per-AVD snapshot keyed by system image and launches from it unless the user opts out (a config key and `WARDEN_*` env override, both additive). The on-device timing check in section 7 still gates the change. |
| 1 | 9.2 Warm pool (16-13, 16-9) | Fix the race (16-1) and SessionEnd (20-2) only; propose `warden warm` | No change to the 20 min idle window; `warden warm` is written up as a proposal, not built. |
| 1 | 9.6 and plan Q5: contract changes | **Additive only** | No `Driver` v2, no wire or CLI removals. Additive wire fields (01-1 `pid`, 06-2 quiet stamp, 02-3 read timings) are allowed; the 15 non-additive findings in Appendix A stay proposals. |
| 2 | 9.18 Follow-up implementation | **Multi-agent wave now**, about 10 opus agents at medium effort | Wave 1 runs as one agent per cluster, each in its own git worktree with TDD; the orchestrator reviews, merges and runs the suites. Device-only items get fake-driver tests plus a device checklist. |
| 2 | 9.3 `/clear` semantics (20-2) | (a) abort on a zero-row heartbeat **and** (b) `/clear` keeps leases whose pid is alive | Both halves of the 20-2 fix land; (b) changes what `/clear` releases. |
| 2 | 9.4 CNG build under the pre-prebuild key (17-1) | **Yes**: requested key plus an alias row for the post-build key | Accept the key move only when the native dir did not exist before the build and the JS half is unchanged. |
| 2 | 9.8 `warden ui` on a device a running `warden e2e` leased (04-6, 05-2, 20-6) | **Refuse** with a clear message unless `--force` | The CLI names the other owner and pid; `--force` keeps today's behaviour for debugging. |
| 3 | Branch for the implementation | **New branch off `main`**, one new draft PR | `claude/wdn-perf-wave1`; PR #31 stays docs-only. One commit per cluster so a cluster can be reverted alone. |
| 3 | Flake-class Wave 2 items in this wave | **Yes**: 06-1, 07-3, 09-2 as one extra agent | Tap stability check, no re-press after a visible reaction, and the `openLink` sheet fix join Wave 1. |
| 3 | 9.11 Helper replacement on owner change (14-5) | **Only on binary or env change** | ppid churn keeps the running helper; the key is the helper binary and `WARDEN_SIMD_*` env. |
| 3 | 9.14 Dead pid with a fresh heartbeat (18-5) | **Dead pid wins for supervised leases** | Leases with a known local pid are reclaimable once the pid is dead; the heartbeat decides only for leases without a pid. |

## 10. Method and limits

- 21 agents (opus or sonnet, medium effort), one goal and one disjoint file set each; the brief, assignments and rubric are in `docs/audit/BRIEF.md` and `ASSIGN-*.md`. One agent (08) was respawned after its progress could not be observed; both runs finished minutes apart and the second kept the first's file, so there is one version. One agent (15) wrote a 4.6 MB build artifact into `apps/cli/src` during a size measurement and removed it on request; nothing outside `docs/audit/` changed.
- Verification: the 40 P0/P1 findings went through two skeptic agents each (mechanism lens, impact lens), batched so no agent judged its own author's work; 31 confirmed, 9 partly, none refuted; 30 severities lowered. The orchestrator read the cited lines for 17-1, 17-2, 17-3, 18-1, 18-2, 09-5, 20-2 and 16-1 and agrees with the mechanism verdicts. P2 and P3 findings carry their author's severity and were not independently verified.
- Baseline here: typecheck green; 4,109 of 4,120 tests pass; the 11 failures are container-bound (no IPv6, no doctor tools, a 5 s exec timeout) and the same suites ran green on macOS CI for PR #31 (`docs/audit/raw/00-baseline-tests.txt`).
- The PR's intermediate commits show red `ci` checks because `cancel-in-progress` cancelled superseded runs and the `ci` aggregator (`ci.yml:170`) treats a cancelled `checks` job as a failure; every completed head is green. Exempting `cancelled` in the aggregator is a small CI item.
- Costs: about 5.1 M subagent tokens for the 20 audits, 1.8 M for the skeptic pass.

---

## Appendix A. Generated tables

Produced from `docs/audit/raw/*.jsonl` and `docs/audit/verify/p0p1-verdicts.jsonl` by the orchestrator's merge script.

### Counts

| | P2 | P3 | P1 | total |
|---|---|---|---|---|
| verified severity | 160 | 87 | 16 | 263 |
| author severity | 134 | 86 | 40 | 263 |

By category: robustness 64 · perf-latency 59 · correctness 42 · flake-risk 31 · dx 23 · test-gap 18 · perf-cpu 13 · cold-boot 8 · perf-ram 5.

By platform: both 85 · host 69 · ios 65 · android 44.

Known-items status: new 208 · known-extended 45 · known-confirmed 5 · claimed-fixed-not-landed 5.

Need a device to confirm: 116. Policy changes: 24. Non-additive (contract) fixes: 15.

### Ranked findings (verified severity)

`m` = measured, `e` = estimated. Verified = outcome of the two-skeptic pass (P0/P1 only); P2/P3 carry the author's severity.

| # | ID | Sev | Verified | Cat | Platform | Title | Saving | Effort | Device? | Primary |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10-1 | P1 | confirmed | flake-risk | both | Session turns lost after ~2 s and is never revived |  | M | yes | `packages/e2e/src/devtools/session.ts:17` |
| 2 | 11-2 | P1 | confirmed | correctness | both | Landmark check turns moved into absent so negative assertions pass falsely |  | M |  | `packages/e2e/src/flows/replay.ts:387` |
| 3 | 16-2 | P1 | confirmed | robustness | both | A device that never gets ready is neither quarantined nor retried, and is picked first again next time | 300000 ms/rep (e) | S |  | `packages/core/src/claim.ts:195` |
| 4 | 17-1 | P1 (was P0) | confirmed | correctness | both | K8a: expo prebuild moves the native fingerprint mid-build; runLocalBuild refuses to cache, and re-keying alone still rebuilds for device 2 and other worktrees |  | M | yes | `packages/core/src/builds/local.ts:168` |
| 5 | 17-2 | P1 (was P0) | confirmed | correctness | both | K8b: locateArtifact only accepts outputs modified after the build start; up-to-date Gradle/Xcode runs find no artifact |  | S | yes | `packages/core/src/builds/local.ts:84` |
| 6 | 18-1 | P1 | confirmed | correctness | host | changedFiles mixes repo-root and cwd-relative paths: untracked files vanish for a subdirectory config |  | S |  | `packages/core/src/affected/git.ts:59` |
| 7 | 18-2 | P1 | confirmed | robustness | host | isPortFree treats a code-less IPv6 bind error as busy: no port lease possible on IPv6-less hosts |  | S |  | `packages/core/src/ports.ts:38` |
| 8 | 20-1 | P1 | confirmed | flake-risk | ios | Failed or skipped warm-up runs a second helper per job beside the resident one (two quiescence streams per sim) | 2200 ms/test (e) | S | yes | `apps/cli/src/e2e/warm-connect.ts:36` |
| 9 | 05-1 | P1 | confirmed | correctness | android | alert("accept") presses "Don't allow" on Android 11+ runtime-permission prompts |  | S | yes | `packages/e2e/src/driver/android/android-alert.ts:12` |
| 10 | 09-5 | P1 | confirmed | correctness | android | Android app.open() fails whenever WARDEN_LAUNCH_ARGS is non-empty (always with Metro --initialUrl) |  | S | yes | `packages/e2e/src/app.ts:73` |
| 11 | 12-2 | P1 | confirmed | robustness | both | Auto-gc spawned just before the claim races the claim for idle booted sims | 20000 ms/rep (e) | S | yes | `apps/cli/src/commands/batch.ts:1615` |
| 12 | 16-1 | P1 (was P0) | confirmed | flake-risk | both | Auto-gc started by a claiming command shuts down the idle device that same command is about to reuse | 6500 ms/rep (e) | M | yes | `apps/cli/src/commands/gc.ts:129` |
| 13 | 21-1 | P1 | not verified (P2/P3) | test-gap | host | commands/e2e.test.ts builds a git repo twice per test (beforeEach plus resuite) |  | S |  | `apps/cli/src/commands/e2e.test.ts:20` |
| 14 | 21-2 | P1 | not verified (P2/P3) | dx | host | No package runs bun test --parallel; cli suite is serial at 56 s |  | S |  | `apps/cli/package.json:1` |
| 15 | 21-4 | P1 | not verified (P2/P3) | test-gap | host | One root cause (18-2) fails 8 cli tests and 1 core test; port release NaN is a cascade |  | S |  | `apps/cli/src/commands/port.test.ts:103` |
| 16 | 20-2 | P1 | partly | correctness | both | SessionEnd (and /clear) releases a live run's leases and stops its helpers; holdLeases ignores heartbeat()'s 0 count |  | S |  | `apps/cli/src/lease-session.ts:471` |
| 17 | 03-1 | P2 (was P1) | confirmed | robustness | ios | Socket client never recovers from a lost daemon; retryable E_HELPER_CRASHED burns every action timeout | 30000 ms/test (e) | S | yes | `packages/e2e/src/driver/ios/simd-client.ts:274` |
| 18 | 08-1 | P2 (was P1) | confirmed | flake-risk | both | A timed-out body or hook keeps running and drives the device during cleanup and the next test |  | M |  | `packages/e2e/src/fixtures.ts:32` |
| 19 | 08-2 | P2 (was P1) | confirmed | robustness | both | Post-deadline work is not bounded by bun's 30 s margin; bun starts the next test while the old cleanup runs |  | M |  | `packages/e2e/src/runner/attempt.ts:216` |
| 20 | 10-2 | P2 (was P1) | confirmed | correctness | both | Network drain is destructive and shared; re-install ignores new config |  | M | yes | `packages/e2e/src/devtools/network.script.ts:12` |
| 21 | 11-1 | P2 (was P1) | confirmed | correctness | both | Recorded type and key steps are never exportable |  | S |  | `apps/cli/src/agent-ui/flow-sink.ts:100` |
| 22 | 11-3 | P2 (was P1) | confirmed | robustness | host | Append lock gives up before a dead holder lock is stale and stale-break races |  | S |  | `packages/e2e/src/flows/record.ts:278` |
| 23 | 15-1 | P2 (was P1) | confirmed | perf-ram | host | typescript bundled into every binary for __affected-graph only | 27.9 MB (m) | M |  | `apps/cli/src/update/source-build.ts:202` |
| 24 | 17-4 | P2 (was P1) | confirmed | perf-latency | both | Per-device ensureApp has no in-process single-flight: failing builds/EAS lookups repeat N times, waiters sleep up to 2 s | 1000 ms/rep (e) | S |  | `packages/core/src/builds/resolve.ts:92` |
| 25 | 19-1 | P2 (was P1) | confirmed | robustness | host | realExec timeout is not a bound when a grandchild keeps the pipes open |  | S |  | `packages/e2e-bench/src/harness/exec.ts:115` |
| 26 | 19-6 | P2 (was P1) | confirmed | perf-cpu | both | Resources series averages over prepare, teardown and housekeeping; per-rep CPU-seconds missing |  | M |  | `packages/e2e-bench/src/orchestrator.ts:328` |
| 27 | 04-1 | P2 (was P1) | confirmed | robustness | android | A transient or unrecognised connect failure is persisted as uiadUnsupported and disables the server on that serial until the dex changes | 100000 ms/rep (e) | S | yes | `packages/e2e/src/driver/android/uiad-backend.ts:74` |
| 28 | 06-1 | P2 (was P1) | confirmed | flake-risk | both | Actions aim from a single fresh snapshot with no stability check: the mis-tap race is narrowed, not closed |  | M | yes | `packages/e2e/src/screen/locator.ts:386` |
| 29 | 09-2 | P2 (was P1) | confirmed | flake-risk | ios | systemAlerts "dismiss" cancels the "Open in ...?" sheet, inside openLink({until}) and after it returns, and poisons the no-sheet memo | 6000 ms/test (e) | M | yes | `packages/e2e/src/device-link.ts:167` |
| 30 | 12-1 | P2 (was P1) | confirmed | flake-risk | ios | Late-window hide can reboot a sim under an already-warmed helper; jobs still get its socket |  | S | yes | `apps/cli/src/commands/batch.ts:1326` |
| 31 | 14-1 | P2 (was P1) | confirmed | flake-risk | ios | Spawn deadline abandons a live, still-starting helper; warm path runs cold and collides with it | 4400 ms/test (e) | S | yes | `apps/cli/src/agent-ui/helper.ts:504` |
| 32 | 14-2 | P2 (was P1) | confirmed | robustness | ios | Helper slow to send ready (2 s) treated as absent: second helper spawned beside it, old one never stopped | 4400 ms/test (e) | S | yes | `apps/cli/src/agent-ui/helper.ts:470` |
| 33 | 16-4 | P2 (was P1) | confirmed | flake-risk | android | Android boot right after launch is a one-shot adb devices check that races adb registration |  | S | yes | `packages/core/src/providers/android.ts:275` |
| 34 | 19-2 | P2 (was P1) | confirmed | robustness | both | Bench lease uses the 5-minute agent TTL and is never heartbeated |  | S |  | `packages/e2e-bench/src/harness/device.ts:44` |
| 35 | 19-3 | P2 (was P1) | confirmed | flake-risk | both | Load gate runs before the app build, uses a 1-minute average vs core count, and is never recorded again |  | S | yes | `packages/e2e-bench/src/orchestrator.ts:428` |
| 36 | 01-1 | P2 | not verified (P2/P3) | perf-latency | ios | Bind and frontmost-gated settle re-resolve a pid they already have, and are blind during each lookup | 80 ms/test (e) | S | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:481` |
| 37 | 01-12 | P2 | not verified (P2/P3) | test-gap | ios | Monitor timing runs on the real clock; the snapshot fallback and the reap trigger are untested |  | M |  | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:260` |
| 38 | 02-3 | P2 | not verified (P2/P3) | dx | ios | The 13.0 s/rep snapshot bucket cannot be split between AX read, helper render/encode and transport |  | S | yes | `packages/e2e/src/driver/ios/ios-driver.ts:198` |
| 39 | 03-5 | P2 | not verified (P2/P3) | robustness | ios | typeText timeout ignores the helper's pacing env and has no per-key slack; overflow types partial text |  | S | yes | `packages/e2e/src/driver/ios/type-budget.ts:7` |
| 40 | 03-7 | P2 | not verified (P2/P3) | robustness | ios | simctl timeouts surface as non-retryable E_IO with no 'timed out' in the message |  | S |  | `packages/e2e/src/driver/ios/simctl.ts:213` |
| 41 | 04-2 | P2 | not verified (P2/P3) | robustness | android | uiad-ops stops a healthy server on any non-refusal error it answered; a typeText that typed nothing is surfaced as a failed step |  | S |  | `packages/e2e/src/driver/android/uiad-ops.ts:102` |
| 42 | 04-7 | P2 | not verified (P2/P3) | robustness | host | build.ts --out with no value (or .) recursively deletes the current directory |  | S |  | `packages/e2e/native/android/scripts/build.ts:194` |
| 43 | 04-9 | P2 | not verified (P2/P3) | test-gap | android | Java has no tests; the fake replays the first reply per op from one API 37 happy-path recording; wire agreement table |  | M |  | `packages/e2e/src/driver/android/uiad.testing.ts:58` |
| 44 | 05-2 | P2 | not verified (P2/P3) | flake-risk | android | Animation guard restores scales under a live driver; warden ui flips them every call | 150 ms/test (e) | M | yes | `packages/e2e/src/driver/android/android-state.ts:207` |
| 45 | 05-3 | P2 | not verified (P2/P3) | robustness | android | waitForBoot spins 30 s on a given-up adb session and reports E_NOT_BOOTED | 30000 ms/test (e) | S |  | `packages/e2e/src/driver/android/android-device.ts:31` |
| 46 | 05-5 | P2 | not verified (P2/P3) | perf-latency | android | Transient null-root dump re-probes every route (~4.8 s/attempt x3) and can flip the saved route | 3800 ms/test (e) | S |  | `packages/e2e/src/driver/android/android-dump.ts:87` |
| 47 | 05-7 | P2 | not verified (P2/P3) | test-gap | android | Fakes prefix-match whole ;-joined lines; real-process test never exercises the production open |  | M |  | `packages/e2e/native/scripts/fake-adb.ts:34` |
| 48 | 06-3 | P2 | not verified (P2/P3) | correctness | both | The React tree match cache ignores input: a tap or boundingBox on a React-only match can use a rect up to 450 ms old, from before the last input |  | S |  | `packages/e2e/src/screen/context.ts:167` |
| 49 | 06-5 | P2 | not verified (P2/P3) | correctness | both | devtools.evaluate and reloadJs change the screen without moving the observation generation |  | S |  | `packages/e2e/src/device-devtools.ts:41` |
| 50 | 06-6 | P2 | not verified (P2/P3) | correctness | android | Android: an alert button is pressed at a frame read from a kept snapshot up to 1 s old |  | S |  | `packages/e2e/src/driver/observation-cache.ts:137` |
| 51 | 07-4 | P2 | not verified (P2/P3) | robustness | both | After the attempt deadline, fill's confirm loop spins with zero-length sleeps against the device |  | S |  | `packages/e2e/src/screen/field.ts:59` |
| 52 | 08-3 | P2 | not verified (P2/P3) | correctness | both | Retries and same-title tests share one attempt dir: stale screenshots/failure files in a passed result, traces concatenated |  | S |  | `packages/e2e/src/runner/attempt.ts:159` |
| 53 | 08-4 | P2 | not verified (P2/P3) | robustness | both | beforeAll/afterAll run outside any attempt: no deadline, no trace, no capture, and a throw writes no results lines |  | M |  | `packages/e2e/src/runner/test.ts:197` |
| 54 | 08-6 | P2 | not verified (P2/P3) | correctness | both | Runner never marks or clears the devtools console/network ring per attempt |  | S |  | `packages/e2e/src/runner/attempt.ts:186` |
| 55 | 09-3 | P2 | not verified (P2/P3) | flake-risk | ios | A sheet later than 1.2 s with the app in front is missed, and the no-sheet memo is never invalidated | 6000 ms/test (e) | S | yes | `packages/e2e/src/device-link.ts:124` |
| 56 | 09-6 | P2 | not verified (P2/P3) | robustness | both | Alert-read retries are counted in attempts, not time; openLink can overrun waitMs and throw |  | S |  | `packages/e2e/src/alert-reader.ts:57` |
| 57 | 09-7 | P2 | not verified (P2/P3) | test-gap | ios | Tests run every alert and link timing rule on a fake clock where reads cost 0 ms and frontmost ignores the sheet |  | S |  | `packages/e2e/src/device.test.ts:27` |
| 58 | 10-10 | P2 | not verified (P2/P3) | robustness | host | Collector bookkeeping trusts a bare pid and is not stopped on release |  | M |  | `apps/cli/src/agent-ui/devtools-cli.ts:281` |
| 59 | 10-7 | P2 | not verified (P2/P3) | perf-ram | host | Collector keeps host rings it never reads and writes one row per syscall batch | 10 MB (e) | S |  | `packages/e2e/src/devtools/collector.ts:67` |
| 60 | 10-8 | P2 | not verified (P2/P3) | perf-ram | host | Console lines are uncapped and stored twice (text and args) | 100 MB (e) | S |  | `packages/e2e/src/devtools/console.ts:86` |
| 61 | 10-9 | P2 | not verified (P2/P3) | dx | both | Console and network rings are not cut per attempt |  | S |  | `packages/e2e/src/runner/attempt.ts:296` |
| 62 | 11-10 | P2 | not verified (P2/P3) | robustness | host | export --ids rewrites the user ids module from scratch |  | M |  | `apps/cli/src/agent-ui/flows-command.ts:354` |
| 63 | 11-11 | P2 | not verified (P2/P3) | robustness | both | Secret redaction covers exact matches only and skips get.expected |  | S |  | `apps/cli/src/agent-ui/flow-sink.ts:193` |
| 64 | 11-8 | P2 | not verified (P2/P3) | correctness | both | replay --from past the end passes with zero steps |  | S |  | `apps/cli/src/agent-ui/flows-command.ts:148` |
| 65 | 11-9 | P2 | not verified (P2/P3) | correctness | both | update-snapshots does not refresh landmarks of wait is get scroll-until steps |  | S |  | `packages/e2e/src/flows/replay.ts:363` |
| 66 | 12-3 | P2 | not verified (P2/P3) | perf-latency | both | Global readiness barriers: slowest device on any leg gates every job (warm 120 s, launch unbounded) | 1000 ms/rep (e) | M | yes | `apps/cli/src/commands/batch.ts:1405` |
| 67 | 12-5 | P2 | not verified (P2/P3) | robustness | both | Metro prewarm is not abortable: Ctrl-C or a failed claim waits for the cold bundle |  | S |  | `apps/cli/src/commands/batch.ts:1018` |
| 68 | 12-8 | P2 | not verified (P2/P3) | dx | android | slim: true makes --platform android refuse the whole suite (K10) |  | S |  | `apps/cli/src/commands/e2e.ts:123` |
| 69 | 12-9 | P2 | not verified (P2/P3) | perf-latency | both | Static round-robin shards: one device can idle while the other still has flows (K5) |  | M | yes | `apps/cli/src/e2e/bun-runner.ts:70` |
| 70 | 13-1 | P2 | not verified (P2/P3) | robustness | host | TUI frame timer and hidden cursor not cleaned up when runGrid throws |  | S |  | `apps/cli/src/commands/batch.ts:460` |
| 71 | 13-3 | P2 | not verified (P2/P3) | correctness | ios | --record: early-exiting recorder counts as started, missing marker costs 10 s, mid-run death unnoticed | 0 ms/rep (e) | S | yes | `apps/cli/src/batch/record.ts:25` |
| 72 | 14-4 | P2 | not verified (P2/P3) | robustness | host | Signals sent to recorded helper/recorder pids without identity check (pid reuse) |  | S |  | `apps/cli/src/agent-ui/helper.ts:580` |
| 73 | 14-6 | P2 | not verified (P2/P3) | robustness | both | state.json read-modify-write without lock loses helper/video/recording/collector records |  | S |  | `apps/cli/src/agent-ui/state.ts:146` |
| 74 | 14-7 | P2 | not verified (P2/P3) | perf-cpu | ios | iOS video recorder outlives ui close, release and gc (orphaned simctl io recordVideo) | 0 pct-cpu (e) | S | yes | `apps/cli/src/agent-ui/video.ts:91` |
| 75 | 14-9 | P2 | not verified (P2/P3) | perf-latency | both | --settle and wait stable poll full snapshots by hash instead of the driver's native settle | 100 ms/test (e) | S | yes | `apps/cli/src/agent-ui/snapshot.ts:110` |
| 76 | 15-2 | P2 | not verified (P2/P3) | perf-latency | host | run/dev/app import zod eagerly via ensure.ts, eas.ts, fingerprint.ts, dev.ts | 12.6 MB (m) | M |  | `apps/cli/src/commands/app.ts:4` |
| 77 | 15-3 | P2 | not verified (P2/P3) | test-gap | host | startup.test.ts lacks allowlists for run/dev/app/hook/devices/check/port |  | S |  | `apps/cli/src/startup.test.ts:48` |
| 78 | 16-11 | P2 | not verified (P2/P3) | robustness | both | No timeout on simctl boot/clone/create/list nor adb emu; a wedge hangs the claim and, under the golden lock, blocks everyone's clones for up to 40 min |  | S |  | `packages/core/src/providers/ios.ts:218` |
| 79 | 16-5 | P2 | not verified (P2/P3) | cold-boot | android | Android readiness wait: 2 s poll, an untimed shell per read, and a dead emulator waited out for 300 s | 1000 ms/rep (e) | S |  | `packages/core/src/providers/android.ts:282` |
| 80 | 16-9 | P2 | not verified (P2/P3) | cold-boot | both | SessionEnd --shutdown shuts down every warden device the session held, not what the session booted | 7200 ms/rep (e) | S |  | `packages/core/src/shutdown-policy.ts:8` |
| 81 | 17-10 | P2 | not verified (P2/P3) | robustness | both | Legacy-cache import runs outside the build lock; concurrent devices race on rmSync + cp of one cache dir |  | S |  | `packages/core/src/builds/resolve.ts:86` |
| 82 | 17-11 | P2 | not verified (P2/P3) | robustness | host | Build cache is never pruned automatically; native+js caches a full build per JS change; installs are not prune-protected | 0 MB (e) | S |  | `packages/core/src/builds/prune.ts:54` |
| 83 | 17-8 | P2 | not verified (P2/P3) | robustness | both | eas-cli calls and the Android APK download have no timeout while the build lock is held |  | S |  | `packages/core/src/builds/eas.ts:182` |
| 84 | 17-9 | P2 | not verified (P2/P3) | robustness | android | adb install -r has no fallback for INSTALL_FAILED_UPDATE_INCOMPATIBLE / VERSION_DOWNGRADE |  | S | yes | `packages/core/src/builds/install.ts:35` |
| 85 | 18-3 | P2 | not verified (P2/P3) | perf-latency | host | computeAffected builds the import graph although a runAll hit makes it unreachable | 410 ms/rep (m) | S |  | `packages/core/src/affected/affected.ts:457` |
| 86 | 19-11 | P2 | not verified (P2/P3) | dx | host | Default 3 reps give n=2 warm: p95 is max, median is mean, stddev biased |  | S |  | `packages/e2e-bench/src/results/stats.ts:11` |
| 87 | 19-12 | P2 | not verified (P2/P3) | dx | host | bench compare has no regression guard or comparability check |  | S |  | `packages/e2e-bench/src/report/compare.ts:39` |
| 88 | 19-13 | P2 | not verified (P2/P3) | correctness | host | Non-finite stats written as 0 make regenerated reports show 0 ms for tests that never ran |  | S |  | `packages/e2e-bench/src/results/write.ts:9` |
| 89 | 19-7 | P2 | not verified (P2/P3) | perf-ram | host | Per-process split of host RSS/CPU costs no extra spawn | 33 MB (m) | S |  | `packages/e2e-bench/src/harness/sampler.ts:133` |
| 90 | 19-9 | P2 | not verified (P2/P3) | test-gap | android | Android residue is host-only and cannot see guest processes |  | S | yes | `packages/e2e-bench/src/harness/residue.ts:83` |
| 91 | 20-3 | P2 | not verified (P2/P3) | robustness | host | Recorded-pid kills have no identity check (helper SIGTERM, video SIGINT/SIGKILL, collector SIGTERM) |  | S |  | `apps/cli/src/agent-ui/helper.ts:578` |
| 92 | 20-4 | P2 | not verified (P2/P3) | robustness | ios | warden ui video start recorder outlives release, close, gc and SessionEnd |  | S |  | `apps/cli/src/agent-ui/stop-helper-after.ts:20` |
| 93 | 20-5 | P2 | not verified (P2/P3) | robustness | both | state.json read-modify-write is unlocked: parallel warden ui calls drop helper/video/collector/recording records |  | S |  | `apps/cli/src/agent-ui/state.ts:146` |
| 94 | 20-7 | P2 | not verified (P2/P3) | robustness | both | SIGHUP/SIGKILL of warden e2e/batch leaves detached group jobs and Metro running unsupervised; leases held 30 min |  | S |  | `apps/cli/src/lease-session.ts:20` |
| 95 | 21-3 | P2 | not verified (P2/P3) | perf-latency | host | declarations.test.ts emits the same declarations twice (6.3 s) |  | S |  | `apps/cli/src/npm/declarations.test.ts:48` |
| 96 | 21-5 | P2 | not verified (P2/P3) | test-gap | host | doctor everything-installed test is macOS-only but not marked or injected |  | S |  | `apps/cli/src/commands/doctor.test.ts:87` |
| 97 | 21-6 | P2 | not verified (P2/P3) | robustness | host | realExec timeout does not bound the call when a descendant holds the pipes (dash sh -c sleep) |  | S |  | `packages/e2e-bench/src/harness/exec.ts:114` |
| 98 | 21-7 | P2 | not verified (P2/P3) | dx | host | Unit tests run only on macOS in CI so Linux-only failures are invisible |  | S |  | `.github/workflows/ci.yml:64` |
| 99 | 21-9 | P2 | not verified (P2/P3) | perf-latency | host | helper.integration.test.ts burns about 3.4 s of real waiting on non-injectable constants |  | S |  | `apps/cli/src/agent-ui/helper.ts:31` |
| 100 | 01-2 | P2 | not verified (P2/P3) | flake-risk | ios | A booting app reads as a wedged guest: the snapshot fallback answers early and the reap kills healthy guests | 0 ms/test (e) | S | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:861` |
| 101 | 01-3 | P2 | not verified (P2/P3) | robustness | ios | Guest recycling uses a constant 12 s age and only checks it at rebind | 850 ms/test (e) | M | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:635` |
| 102 | 01-4 | P2 | not verified (P2/P3) | flake-risk | ios | start() during an awaited restart() opens a second stream; stop() never waits for teardown |  | S |  | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:416` |
| 103 | 01-5 | P2 | not verified (P2/P3) | flake-risk | ios | The latched-stream back-off is counted from the restart decision, so slow opens starve the bind |  | S | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:220` |
| 104 | 02-1 | P2 | not verified (P2/P3) | robustness | ios | Response writes block cooperative-pool threads with no send timeout |  | S |  | `packages/e2e/native/ios/Sources/warden-simd/Server/StdioServer.swift:15` |
| 105 | 02-2 | P2 | not verified (P2/P3) | robustness | ios | In-flight ops outlive their client and the shutdown; a hung self-timed op pins idle exit forever |  | M |  | `packages/e2e/native/ios/Sources/warden-simd/Server/StdioServer.swift:110` |
| 106 | 03-2 | P2 | not verified (P2/P3) | robustness | ios | A silent socket waits 15 s, then a second helper is started next to the live daemon | 15000 ms/rep (e) | S | yes | `packages/e2e/src/driver/ios/ios-driver.ts:496` |
| 107 | 03-3 | P2 | not verified (P2/P3) | perf-latency | ios | Bridge-stale recovery shuts down the shared daemon; later spec processes start cold | 500 ms/test (e) | M | yes | `packages/e2e/src/driver/ios/ios-session.ts:59` |
| 108 | 03-4 | P2 | not verified (P2/P3) | perf-latency | ios | Guest recycle sits on the launch critical path, after simctl launch | 1900 ms/rep (e) | M | yes | `packages/e2e/src/driver/ios/ios-driver.ts:466` |
| 109 | 03-6 | P2 | not verified (P2/P3) | flake-risk | ios | Aborted driver calls keep running in the helper (no cancel) |  | M | yes | `packages/e2e/src/driver/unwrap.ts:52` |
| 110 | 04-5 | P2 | not verified (P2/P3) | perf-latency | android | Edit quiet after typeText/key always costs the full 80 ms because server settle counts from the call; defer it to the next input | 1200 ms/rep (e) | S | yes | `packages/e2e/src/driver/android/uiad-ops.ts:129` |
| 111 | 04-6 | P2 | not verified (P2/P3) | flake-risk | android | Busy rule kills any warden-uiad, including one a live warden process (warden ui during warden e2e) is using |  | S | yes | `packages/e2e/src/driver/android/uiad-device.ts:125` |
| 112 | 05-4 | P2 | not verified (P2/P3) | perf-latency | android | app.launch is force-stop + monkey (JVM start, no first-frame wait); use am start -W -n | 400 ms/test (e) | S | yes | `packages/e2e/src/driver/android/android-app.ts:73` |
| 113 | 05-6 | P2 | not verified (P2/P3) | flake-risk | android | Fallback pressKeyRepeat batches up to 32 Backspaces with no gap (drops keys in RN) |  | S | yes | `packages/e2e/src/driver/android/android-argv.ts:91` |
| 114 | 06-2 | P2 | not verified (P2/P3) | perf-latency | both | Assert-then-tap is two snapshots: a snapshot stamped as quiet could let the action reuse the assertion's look | 3400 ms/rep (e) | L | yes | `packages/e2e/src/screen/locator.ts:392` |
| 115 | 06-4 | P2 | not verified (P2/P3) | perf-latency | both | Every no-match poll of a plain getByTestId action reads the React tree, including for actions that can never use it | 250 ms/test (e) | S | yes | `packages/e2e/src/screen/locator.ts:401` |
| 116 | 06-7 | P2 | not verified (P2/P3) | robustness | android | The reuse window is set per platform, not by read cost, and is counted from arrival: Android keeps a snapshot for 1 s while a read costs about 50 ms |  | S |  | `packages/e2e/src/driver/observation-cache.ts:17` |
| 117 | 07-1 | P2 | not verified (P2/P3) | flake-risk | both | Actions tap where one snapshot says the element is, with no stability check |  | M | yes | `packages/e2e/src/screen/locator.ts:386` |
| 118 | 07-2 | P2 | not verified (P2/P3) | perf-latency | ios | Assert-then-tap takes a second full snapshot on iOS where a hit-test would do | 1600 ms/rep (e) | M | yes | `packages/e2e/src/screen/locator.ts:392` |
| 119 | 07-3 | P2 | not verified (P2/P3) | flake-risk | both | tap({until}) re-sends blind after a fixed window: a double press when the first one landed late, ~4 s lost when it was dropped | 1000 ms/rep (e) | M | yes | `packages/e2e/src/screen/locator.ts:446` |
| 120 | 07-6 | P2 | not verified (P2/P3) | correctness | both | Secure fields are never verified after fill, though their dots are already counted |  | S | yes | `packages/e2e/src/screen/locator.ts:526` |
| 121 | 07-7 | P2 | not verified (P2/P3) | robustness | both | fill/clear/type/press tap a focus point that is never checked to be on screen |  | S |  | `packages/e2e/src/screen/field.ts:127` |
| 122 | 08-5 | P2 | not verified (P2/P3) | perf-latency | both | Failure capture is serial and never cancels its calls: up to 30 s per failing test, calls queued ahead of the next launch | 200 ms/test (e) | S | yes | `packages/e2e/src/runner/failure.ts:49` |
| 123 | 09-1 | P2 | not verified (P2/P3) | perf-latency | both | app.open({wait:"quiet"}) goes quiet on the launch screen; the settle is overlapped boot time, not a ready signal | 0 ms/test (e) | M | yes | `packages/e2e/src/app.ts:58` |
| 124 | 09-4 | P2 | not verified (P2/P3) | correctness | ios | app.open({url}) on iOS skips the "Open in ...?" sheet handling |  | S | yes | `packages/e2e/src/app.ts:78` |
| 125 | 10-11 | P2 | not verified (P2/P3) | correctness | both | Slow measurement yields silent not-found; max does not bound measure work |  | S | yes | `packages/e2e/src/devtools/tree.script.ts:439` |
| 126 | 10-12 | P2 | not verified (P2/P3) | correctness | both | Network capture sees fetch only; XHR clients are invisible |  | M | yes | `packages/e2e/src/devtools/network.script.ts:60` |
| 127 | 10-13 | P2 | not verified (P2/P3) | perf-latency | android | ui tree on Android opens the driver before the facet and defaults silently to scale 1 | 150 ms/test (e) | S | yes | `apps/cli/src/agent-ui/devtools-cli.ts:209` |
| 128 | 10-3 | P2 (was P1) | partly | perf-cpu | both | React-tree accelerator walks and measures the whole screen on every poll miss | 20 pct-cpu (e) | M | yes | `packages/e2e/src/devtools/tree.script.ts:383` |
| 129 | 10-5 | P2 | not verified (P2/P3) | flake-risk | both | No deadline when waiting out a reconnect; stale page can be re-selected |  | M | yes | `packages/e2e/src/devtools/session.ts:224` |
| 130 | 10-6 | P2 | not verified (P2/P3) | perf-latency | both | ui eval/tree/reload opens a full facet and patches the app's fetch | 50 ms/test (e) | M | yes | `apps/cli/src/agent-ui/devtools-cli.ts:126` |
| 131 | 11-5 | P2 | not verified (P2/P3) | perf-latency | both | Replay takes more snapshots per step than needed | 840 ms/rep (e) | M | yes | `packages/e2e/src/flows/replay.ts:341` |
| 132 | 11-6 | P2 | not verified (P2/P3) | perf-latency | ios | Replay settle polls snapshots instead of driver.settle and ignores quietMs | 3500 ms/rep (e) | S | yes | `apps/cli/src/agent-ui/flows-command.ts:196` |
| 133 | 11-7 | P2 | not verified (P2/P3) | correctness | android | Android screen hash ignores static text so drift and settle are blind to text changes |  | S | yes | `packages/e2e/src/driver/settle.ts:77` |
| 134 | 12-4 | P2 | not verified (P2/P3) | perf-latency | ios | slim waits behind the Metro await and the installs although it only needs a booted sim | 400 ms/rep (e) | S | yes | `apps/cli/src/commands/batch.ts:1405` |
| 135 | 12-6 | P2 | not verified (P2/P3) | perf-latency | ios | iOS openOnDevices: unbounded simctl launch on the critical path, then the spec relaunches anyway | 1000 ms/rep (e) | S | yes | `apps/cli/src/commands/batch.ts:1075` |
| 136 | 12-7 | P2 | not verified (P2/P3) | robustness | android | Android: a failed adb reverse only warns, and the device then runs every flow against an unreachable Metro |  | S | yes | `apps/cli/src/commands/batch.ts:1076` |
| 137 | 13-2 | P2 | not verified (P2/P3) | perf-latency | both | Failure screenshot awaited inline, duplicates runner failure.png and shows end of shard | 300 ms/rep (e) | M | yes | `apps/cli/src/commands/batch.ts:751` |
| 138 | 13-4 | P2 | not verified (P2/P3) | test-gap | host | No bench or test measures the parent process; K12 12.1 percent excludes it | 0.3 pct-cpu (e) | M | yes | `docs/plans/wdn-perf.md:381` |
| 139 | 14-10 | P2 | not verified (P2/P3) | cold-boot | ios | AutomationEnabled probe/write runs serially after ensureHelper on ui and warm paths | 400 ms/rep (e) | S | yes | `apps/cli/src/e2e/warm-connect.ts:16` |
| 140 | 14-3 | P2 (was P1) | partly | correctness | ios | stopHelper is unarbitrated: a stop racing a spawn unlinks the new helper's socket and forgets its record | 4400 ms/test (e) | S |  | `apps/cli/src/agent-ui/helper.ts:583` |
| 141 | 14-5 | P2 | not verified (P2/P3) | perf-latency | ios | Resident helper replaced every run when owner key churns (user:<ppid>, CI run id) or helper path resolves differently | 2000 ms/rep (e) | M | yes | `apps/cli/src/agent-ui/helper.ts:342` |
| 142 | 14-8 | P2 (was P1) | partly | perf-latency | android | Android: every warden ui call rebuilds the driver (adb shell, probe, animations off/on, uiad start/stop) | 450 ms/test (e) | L | yes | `apps/cli/src/agent-ui/ui-driver.ts:25` |
| 143 | 15-4 | P2 | not verified (P2/P3) | robustness | host | npm shim uses spawnSync and never forwards signals |  | S |  | `apps/cli/src/npm/shim-main.ts:35` |
| 144 | 16-10 | P2 | not verified (P2/P3) | robustness | ios | Probe time-outs under host load quarantine healthy sims for good, and a bad claim can run 3 cold boots (~100 s) | 15600 ms/rep (e) | M | yes | `packages/core/src/claim.ts:299` |
| 145 | 16-12 | P2 | not verified (P2/P3) | cold-boot | ios | slim costs ~1.6-2.7 s per fresh sim on the critical path, the benefit is unmeasured, and a plain claim re-arms the full cost | 1000 ms/rep (e) | S | yes | `packages/core/src/sims/slim.ts:178` |
| 146 | 16-13 | P2 | not verified (P2/P3) | cold-boot | both | What keeps the second run of the day from starting warm: gc idle, helper idle, SessionEnd, and no pre-boot | 7000 ms/rep (m) | M | yes | `packages/core/src/config.defaults.ts:6` |
| 147 | 16-3 | P2 (was P1) | partly | cold-boot | android | Android: no warden-owned quick-boot snapshot; boot time and start state depend on the user's AVD | 25000 ms/rep (e) | L | yes | `packages/core/src/providers/android.ts:220` |
| 148 | 16-6 | P2 | not verified (P2/P3) | cold-boot | ios | Golden clones are serialised behind a 2 s-poll lock, with 3 serial pre-lock spawns and a full simctl list per device | 8000 ms/rep (e) | M | yes | `packages/core/src/golden/ios-golden.ts:265` |
| 149 | 16-8 | P2 | not verified (P2/P3) | flake-risk | ios | Headless hide: concurrent hides race on the global DetachOnWindowClose, and shut-down sims reboot one after another, unprobed | 6500 ms/rep (e) | M | yes | `apps/cli/src/sim-windows.ts:271` |
| 150 | 17-3 | P2 (was P1) | partly | correctness | ios | iOS artifact search takes the newest .app across every DerivedData project; a parallel worktree's build can be cached under this key |  | M | yes | `packages/core/src/builds/local.ts:70` |
| 151 | 17-5 | P2 | not verified (P2/P3) | perf-latency | both | PERF-4.6 fingerprint memo never landed: @expo/fingerprint runs on every ensure, now on the critical path with warm sims | 2500 ms/rep (e) | M |  | `packages/core/src/builds/fingerprint.ts:96` |
| 152 | 17-6 | P2 | not verified (P2/P3) | correctness | android | Android trusts the install record; a foreign install of the same package is never detected |  | S | yes | `packages/core/src/builds/install.ts:115` |
| 153 | 17-7 | P2 | not verified (P2/P3) | correctness | ios | iOS identity check runs 2 plutil per ensure, misses same-size JS changes; the post-install container path is discarded | 2 spawns/run (e) | M | yes | `packages/core/src/builds/install.ts:118` |
| 154 | 18-4 | P2 | not verified (P2/P3) | perf-latency | host | Cold graph walk is about 400 ms, re-paid after every edit, import cache does not help | 300 ms/rep (e) | M |  | `packages/core/src/affected/graph.ts:190` |
| 155 | 18-5 | P2 | not verified (P2/P3) | robustness | both | Crashed lease holder keeps device and ports until the 30 min TTL (dead pid + fresh heartbeat is alive) |  | M | yes | `packages/core/src/liveness.ts:7` |
| 156 | 18-6 | P2 | not verified (P2/P3) | robustness | host | Blocked BEGIN IMMEDIATE freezes the process for 15 s then throws inside the uncaught heartbeat timer |  | S |  | `packages/core/src/store.ts:394` |
| 157 | 18-7 | P2 | not verified (P2/P3) | flake-risk | both | Retry runs on the same worker: one bad device spends every retry and drains the queue |  | M | yes | `packages/core/src/batch/schedule.ts:74` |
| 158 | 19-14 | P2 | not verified (P2/P3) | perf-latency | ios | prepareMs includes a bun cli.ts process start, so the 300 ms target is unreachable by helper work alone | 140 ms/rep (e) | S | yes | `packages/e2e-bench/src/adapters/warden.ts:160` |
| 159 | 19-15 | P2 | not verified (P2/P3) | test-gap | android | Android snapshotWarm target 800 ms predates warden-uiad and misses regressions |  | S | yes | `apps/cli/src/agent-ui/bench.ts:55` |
| 160 | 19-4 | P2 | not verified (P2/P3) | flake-risk | both | Fixed framework order puts warden first every run |  | S | yes | `packages/e2e-bench/src/args.ts:40` |
| 161 | 19-5 | P2 (was P1) | partly | correctness | host | ps %cpu is not the CPU used in the last tick on macOS | 0 pct-cpu (e) | M | yes | `packages/e2e-bench/src/harness/sampler.ts:19` |
| 162 | 19-8 | P2 | not verified (P2/P3) | test-gap | both | Emulator/CoreSimulator backend processes are in neither host nor sim series |  | S | yes | `packages/e2e-bench/src/harness/sampler.ts:88` |
| 163 | 20-6 | P2 | not verified (P2/P3) | flake-risk | android | Android: concurrent drivers on one serial kill each other's live warden-uiad as stale | 1900 ms/test (e) | M | yes | `packages/e2e/src/driver/android/uiad-device.ts:170` |
| 164 | 20-8 | P2 | not verified (P2/P3) | correctness | ios | Inherited WARDEN_SIMD_SOCKET reaches jobs of devices that did not warm; ready.udid never checked |  | S |  | `packages/e2e/src/driver/ios/ios-driver.ts:494` |
| 165 | 21-8 | P2 | not verified (P2/P3) | flake-risk | host | Wall-clock assertions with thin margins (ui close < 2.5 s vs 2 s wait) flake on loaded runners |  | M |  | `apps/cli/src/agent-ui/helper.integration.test.ts:142` |
| 166 | 01-6 | P2 | not verified (P2/P3) | perf-cpu | ios | The lifetime stream stays open while no client is connected, on a resident helper | 0 pct-cpu (e) | S | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:247` |
| 167 | 01-7 | P2 | not verified (P2/P3) | correctness | ios | Stream quiet cannot see JS-thread work, so app.open({wait:"quiet"}) settles on the splash |  | M | yes | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:583` |
| 168 | 03-8 | P2 | not verified (P2/P3) | robustness | ios | Every FBSOpenApplicationServiceErrorDomain failure on launch/openurl is classed app unavailable |  | S | yes | `packages/e2e/src/driver/ios/simctl.ts:164` |
| 169 | 04-3 | P2 | not verified (P2/P3) | correctness | android | fresh:true is a silent no-op below API 34 (UiAutomation.clearCache swallowed); reads on API 26-33 may come from the event cache |  | S | yes | `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Uia.java:415` |
| 170 | 04-4 | P2 | not verified (P2/P3) | perf-latency | android | Snapshot p95 tail: one getChild round trip per uncached node into the busy app UI thread; no miss counters, no prefetch strategy | 500 ms/rep (e) | M | yes | `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Uia.java:394` |
| 171 | 04-8 | P2 | not verified (P2/P3) | perf-ram | android | warden-uiad ~143 MB device RSS is VmRSS only: no PSS/private split, no VM options tried, 4-5 payload copies per reply | 0 MB (e) | M | yes | `packages/e2e/native/android/scripts/smoke.ts:520` |
| 172 | 06-8 | P2 | not verified (P2/P3) | flake-risk | both | Strictness throws on the first ambiguous poll of a wait: a transient duplicate during a transition ends the action |  | S | yes | `packages/e2e/src/screen/locator.ts:402` |
| 173 | 10-4 | P2 (was P1) | partly | correctness | android | Android devtools target uses the AVD name; Metro reports the device model |  | M | yes | `packages/e2e/src/devtools/inspector.ts:154` |
| 174 | 11-15 | P2 | not verified (P2/P3) | flake-risk | android | Landmark tolerance fixed at 40 units and recordedOn unused at replay |  | S | yes | `packages/e2e/src/flows/replay.ts:18` |
| 175 | 19-10 | P2 | not verified (P2/P3) | perf-cpu | both | Sampler ps and adb top add unaccounted load; queued ticks bunch up | 5 pct-cpu (e) | S | yes | `packages/e2e-bench/src/harness/sampler.ts:274` |
| 176 | 19-16 | P2 | not verified (P2/P3) | perf-latency | both | tap({until}) 4 s re-send window is headroom that inflates warm medians when a press is dropped | 1500 ms/rep (e) | S | yes | `packages/e2e-bench/suites/warden/helpers/flows.ts:65` |

<details><summary>P3 findings (87)</summary>

| ID | Cat | Title | Primary |
|---|---|---|---|
| 01-11 | perf-latency | frontmost asks launchd on every call while another app is in front | `packages/e2e/native/ios/Sources/warden-simd/Ops/Snapshot.swift:592` |
| 01-9 | perf-latency | The wedge reap runs on the settle's reply path | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:861` |
| 02-5 | correctness | Empty-root recovery ignores snapshot{pid} and is invisible in the reply | `packages/e2e/native/ios/Sources/warden-simd/Ops/Snapshot.swift:332` |
| 02-6 | test-gap | Wire agreement is pinned for element payloads only; fake-simd drifts from the Swift server | `packages/e2e/native/scripts/element-shape.test.ts:37` |
| 02-7 | robustness | Key-pacing env overrides are invisible to the TS typeText budget | `packages/e2e/src/driver/ios/type-budget.ts:2` |
| 03-10 | test-gap | No record of where app.launch time goes; the smoke script cannot measure it or socket recovery | `packages/e2e/src/driver/ios/ios-driver.ts:466` |
| 03-11 | robustness | Client timer equals the helper's envelope timeout, so the helper's own timeout answer is always dropped | `packages/e2e/src/driver/ios/simd-client.ts:330` |
| 03-9 | dx | toE2eError drops retryable and detail | `packages/e2e/src/driver/unwrap.ts:24` |
| 04-12 | dx | MIN_PLATFORM 30 cannot compile Uia.java (clearCache needs android.jar 34+); plan wire defaults differ from the Java | `packages/e2e/native/android/scripts/build.ts:30` |
| 04-13 | dx | Wire fields dropped by the host (pkg 28% and order 7% of snapshot bytes) and K6 attribution fields (readMs, nodes, settle events, inject via) not on spans | `packages/e2e/src/driver/android/uiad-ops.ts:146` |
| 05-11 | dx | smoke-android.ts no longer smokes the production configuration (no uiad, no state) | `packages/e2e/native/scripts/smoke-android.ts:54` |
| 06-9 | dx | locator("text=...") selectors are neither innermost-filtered nor ranked in specs, while warden ui ranks them | `packages/e2e/src/screen/query.ts:103` |
| 07-5 | test-gap | fakeClock().sleep ignores the abort signal, unlike systemClock | `packages/e2e/src/screen/poll.testing.ts:17` |
| 07-8 | perf-latency | .not matchers always hold a full 1 s; the planned early end on quiet did not land, and its stated reason is stale | `packages/e2e/src/expect/matchers.ts:17` |
| 08-10 | dx | launch: "fresh" cannot wait for the app, so real suites opt out and relaunch by hand | `packages/e2e/src/runner/attempt.ts:282` |
| 08-8 | robustness | Spans after flush() and buffered spans of a running step are lost on a late call or a kill | `packages/e2e/src/runner/trace.ts:72` |
| 08-9 | dx | Preload docs contradict behaviour: version check called a warning but exits 2; 'opens the session eagerly' does not open the driver | `packages/e2e/src/preload.ts:32` |
| 09-10 | perf-latency | openLink({until}) polls at 250 ms after the hand-over and overshoots waitMs by up to one poll plus one look | `packages/e2e/src/device-link.ts:141` |
| 09-11 | perf-latency | device.hideKeyboard() always takes a fresh full snapshot | `packages/e2e/src/device.ts:233` |
| 09-9 | perf-latency | app.reinstall() probes installed twice | `packages/e2e/src/app.ts:102` |
| 10-15 | robustness | Small session leaks: onCdp unsubscribe, polling-path results, ring slice | `packages/e2e/src/devtools/session.ts:330` |
| 10-16 | test-gap | Fakes cannot reproduce already-installed, shared-consumer or lingering-page shapes | `packages/e2e/src/devtools/devtools.testing.ts:195` |
| 10-17 | correctness | logs start truncates the previous window's console and network files | `packages/e2e/src/devtools/collector.ts:50` |
| 11-12 | perf-latency | Each append re-parses and re-serialises the whole flow | `packages/e2e/src/flows/record.ts:286` |
| 11-13 | dx | Flow v is a literal 1 with no migration path or helpful error | `packages/e2e/src/flows/flow.schema.ts:175` |
| 11-16 | dx | Replay hides its own log lines | `apps/cli/src/agent-ui/flows-command.ts:206` |
| 11-17 | test-gap | No tests for flow-actors, lock races or sink-to-export | `apps/cli/src/agent-ui/flow-actors.ts:1` |
| 12-10 | correctness | A CLI --passes N bypasses the isolation rule: whole shards rerun, and passes share one out dir | `apps/cli/src/commands/e2e.ts:442` |
| 12-11 | robustness | Teardown runs its 15 s graces in series before the report; a second Ctrl-C does not escalate | `apps/cli/src/commands/batch.ts:1382` |
| 12-12 | perf-latency | One leg's failed claim does not stop the other legs' installs; the failure is reported only after them | `apps/cli/src/lease-session.ts:371` |
| 12-13 | correctness | --dry-run reports ok: true for a run that would be refused | `apps/cli/src/commands/e2e.ts:288` |
| 12-14 | dx | apps/example/warden.config.ts says example runs one spec process per flow; it runs one per device | `apps/example/warden.config.ts:63` |
| 13-5 | perf-cpu | Results lines parsed 3 times and realpathSync uncached per result x flow in verdict pass | `apps/cli/src/batch/flow-progress.ts:26` |
| 13-8 | dx | tui.cast height fixed at first frame and live grid ignores terminal resize | `apps/cli/src/commands/batch.ts:443` |
| 14-11 | perf-latency | swipe/scroll take a full snapshot only for the screen size; scroll --until snapshots again immediately | `apps/cli/src/agent-ui/actions.ts:361` |
| 14-13 | test-gap | Helper race and leak paths untested; multi-process race test can pass without a collision | `apps/cli/src/agent-ui/helper.integration.test.ts:91` |
| 14-14 | perf-latency | ui close --app spawns a helper only to terminate the app, then stops it; driver closed twice | `apps/cli/src/agent-ui/close.ts:33` |
| 15-5 | perf-latency | root --help and help <cmd> load all 28 commands | `apps/cli/src/command.ts:411` |
| 15-6 | robustness | deps.ts: download without timeout, from-source not idempotent, non-atomic swap | `packages/e2e/native/scripts/deps.ts:78` |
| 16-14 | perf-latency | Android claim spawns: emulator -list-avds twice per auto-profile create, and an untimed console call per running emulator per round | `apps/cli/src/claim-flags.ts:167` |
| 16-7 | cold-boot | AutomationEnabled is not baked into the golden, so every fresh clone pays the in-sim defaults write | `packages/core/src/golden/ios-golden.ts:175` |
| 17-12 | perf-cpu | warden e2e --app evaluates warden.config.ts 3x and spawns git config for a project key specBundleId never uses | `packages/core/src/builds/config.ts:363` |
| 17-13 | dx | warden app fingerprint fingerprints iOS then Android serially | `apps/cli/src/commands/app.ts:282` |
| 17-14 | robustness | Build-lock wait (90 min) is shorter than a legitimate holder (45 min EAS + 60 min build) | `packages/core/src/builds/lock.ts:74` |
| 17-15 | perf-cpu | Per-command git-facts memo expires after 5 s; clean/uninstall paths re-probe what confirm already saw | `packages/core/src/git-facts.ts:45` |
| 18-10 | robustness | Import cache written non-atomically and never pruned | `packages/core/src/affected/cache.ts:116` |
| 18-11 | perf-latency | warden e2e computes both platforms serially, then rejects the ambiguity | `packages/core/src/affected/affected.ts:462` |
| 18-8 | perf-latency | Warm affected path is 6 serial-ish git spawns plus sync content hashing of dirty files | `packages/core/src/affected/git.ts:54` |
| 18-9 | perf-latency | warden run / dev load the builds config schemas (zod) at registration, about 50 ms | `apps/cli/src/lease-session.ts:12` |
| 19-19 | robustness | Second SIGINT skips cleanup: lease and Android device settings left behind | `packages/e2e-bench/src/cli.ts:128` |
| 20-10 | robustness | warden install writes ~/.claude/settings.json non-atomically after a prompt | `apps/cli/src/commands/install.ts:214` |
| 20-11 | dx | A second Ctrl-C does not escalate; batch teardown can block ~45 s | `apps/cli/src/commands/batch.ts:1372` |
| 21-12 | dx | bare bun test in packages/e2e-bench picks up the Detox suite and fails 8 tests | `packages/e2e-bench/package.json:1` |
| 01-10 | perf-latency | Recycling blocks a concurrency thread on ps and sleeps a fixed 150 ms | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:751` |
| 01-8 | perf-cpu | The stuck-stream restart at 400 ms has helped in no measured case | `packages/e2e/native/ios/Sources/warden-simd/Ops/Settle.swift:114` |
| 02-4 | robustness | An encode failure answers with id null, which the TS client discards | `packages/e2e/native/ios/Sources/warden-simd/Protocol/NDJSON.swift:18` |
| 04-10 | correctness | ACTION_SET_SELECTION returns false when selection already matches: selectAll reports E_HID on a fully selected field, caretPlaced false on every recorded typeText | `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Uia.java:628` |
| 04-11 | correctness | scope:"all" switches interactive-window retrieval off before walking non-active windows, truncating them silently | `packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Uia.java:289` |
| 04-14 | perf-latency | Every server start pays a separate dex-present shell round trip; fold it into the launch command | `packages/e2e/src/driver/android/uiad-device.ts:90` |
| 05-10 | correctness | Fallback tap({count:2}) is two slow single taps, not a double tap | `packages/e2e/src/driver/android/android-driver.ts:367` |
| 05-8 | correctness | key(name, modifiers) reports success on API <=30 where input keycombination does not exist | `packages/e2e/src/driver/android/android-driver.ts:388` |
| 05-9 | robustness | ;-joined lines mask failures: animation read/restore judged by the last command only | `packages/e2e/src/driver/android/android-animations.ts:44` |
| 06-10 | perf-cpu | Query-layer CPU per read is sub-millisecond: the host CPU gap is not in the screen layer | `packages/e2e/src/screen/text.ts:19` |
| 06-11 | robustness | The kept snapshot survives attempt and test boundaries | `packages/e2e/src/session.ts:200` |
| 07-10 | perf-latency | The Android setText op is implemented in warden-uiad but no TS code calls it | `packages/e2e/src/screen/field.ts:127` |
| 07-9 | perf-latency | The fill retry path waits a full second on a stable wrong value, then presses N+1 single-key RPCs on iOS | `packages/e2e/src/screen/field.ts:80` |
| 08-7 | perf-latency | Driver open happens lazily inside the first test's attempt, serial with spec collection and untraced | `packages/e2e/src/preload.ts:67` |
| 09-8 | perf-latency | app.clearData() on iOS is 7 serial xcrun simctl spawns | `packages/core/src/builds/install.ts:220` |
| 10-14 | perf-cpu | Idle 500 ms drain poll keeps the page busy when no sink reads it | `packages/e2e/src/devtools/network.ts:133` |
| 11-14 | correctness | Export edge cases that produce a spec that does not parse or typecheck | `packages/e2e/src/flows/export.ts:405` |
| 11-4 | robustness | record start can overwrite concurrent state.json writes (helper record) | `apps/cli/src/agent-ui/flows-command.ts:94` |
| 13-6 | perf-cpu | Parent still stamps every log chunk (plan says child) and drained polls every 10 ms | `apps/cli/src/batch/stamped-log.ts:27` |
| 13-7 | robustness | A failed log write ends the pump so the child pipe stops being read | `apps/cli/src/batch/stamped-log.ts:36` |
| 14-12 | perf-latency | Per-call fixed costs: git rev-parse spawn, unconditional last-snapshot zod parse, Android modules on iOS, double hash | `apps/cli/src/claim-flags.ts:117` |
| 15-7 | perf-latency | published e2e bundle unminified and loads zod at import | `apps/cli/src/npm/e2e-bundle.ts:15` |
| 16-15 | perf-latency | iOS boot path: simctl boot before bootstatus -b is a redundant spawn; the full probe right after bootstatus is ~2 more | `packages/core/src/providers/ios.ts:305` |
| 16-16 | dx | defaultMax = floor(cores/4) <= 4 is CPU-only: 3 on the 14-core bench host, and blind to RAM | `packages/core/src/allocate.ts:29` |
| 19-17 | perf-latency | Rep wallMs includes adapter post-processing and discards the adapter's own wall | `packages/e2e-bench/src/orchestrator.ts:208` |
| 19-18 | flake-risk | warden ui bench taps screen centre so pressSettle depends on app state | `apps/cli/src/agent-ui/bench.ts:281` |
| 20-9 | robustness | doctor --fetch-helper deletes the directory a resident helper runs from | `apps/cli/src/update/fetch-helper.ts:95` |
| 21-11 | dx | help.test.ts snapshot is 85 KB across 31 entries (churn on every flag change) | `apps/cli/src/__snapshots__/help.test.ts.snap:1` |
| 07-11 | flake-risk | Matchers and actions throw on several matches at once, with no poll for a transition to finish | `packages/e2e/src/expect/matchers.ts:302` |
| 13-9 | robustness | Throwing sink in the poller timer becomes an unhandled rejection | `apps/cli/src/batch/flow-poller.ts:85` |
| 16-17 | perf-cpu | Android launch argv omits cheap headless flags (-no-audio, -no-metrics), and AVD hw.* defaults go unchecked | `packages/core/src/providers/android.ts:220` |
| 18-12 | correctness | Snapshot key can serve a stale graph (gitignored resolved files; edit during the walk) | `packages/core/src/affected/graph-snapshot.ts:249` |
| 19-20 | flake-risk | With --retries N warden results hide failed attempts | `packages/e2e-bench/src/adapters/warden.ts:75` |
| 21-10 | perf-latency | core/affected tests spawn a real worker bun and load TypeScript per case (about 10 s of 15 s) | `packages/core/src/affected/graph-process.test.ts:1` |

</details>

### Findings by track

#### 01 · iOS helper (settle) (12: 0 P0, 0 P1, 8 P2, 4 P3) — `docs/audit/raw/01-ios-helper-settle.md`

- **01-1** [P2, perf-latency, K18] Bind and frontmost-gated settle re-resolve a pid they already have, and are blind during each lookup — 80 ms/test (e) — needs device
- **01-12** [P2, test-gap] Monitor timing runs on the real clock; the snapshot fallback and the reap trigger are untested
- **01-2** [P2, flake-risk, K7] A booting app reads as a wedged guest: the snapshot fallback answers early and the reap kills healthy guests — 0 ms/test (e) — needs device
- **01-3** [P2, robustness, K7] Guest recycling uses a constant 12 s age and only checks it at rebind — 850 ms/test (e) — needs device
- **01-4** [P2, flake-risk] start() during an awaited restart() opens a second stream; stop() never waits for teardown
- **01-5** [P2, flake-risk] The latched-stream back-off is counted from the restart decision, so slow opens starve the bind — needs device
- **01-6** [P2, perf-cpu] The lifetime stream stays open while no client is connected, on a resident helper — 0 pct-cpu (e) — needs device
- **01-7** [P2, correctness, K15] Stream quiet cannot see JS-thread work, so app.open({wait:"quiet"}) settles on the splash — needs device
- **01-11** [P3, perf-latency] frontmost asks launchd on every call while another app is in front — 17 spawns/run (e)
- **01-9** [P3, perf-latency] The wedge reap runs on the settle's reply path — 250 ms/test (e)
- **01-10** [P3, perf-latency, K7] Recycling blocks a concurrency thread on ps and sleeps a fixed 150 ms — 70 ms/test (e) — needs device
- **01-8** [P3, perf-cpu] The stuck-stream restart at 400 ms has helped in no measured case — needs device

#### 02 · iOS helper (I/O, wire) (7: 0 P0, 0 P1, 3 P2, 4 P3) — `docs/audit/raw/02-ios-helper-io.md`

- **02-3** [P2, dx, K1] The 13.0 s/rep snapshot bucket cannot be split between AX read, helper render/encode and transport — needs device
- **02-1** [P2, robustness] Response writes block cooperative-pool threads with no send timeout
- **02-2** [P2, robustness] In-flight ops outlive their client and the shutdown; a hung self-timed op pins idle exit forever
- **02-5** [P3, correctness] Empty-root recovery ignores snapshot{pid} and is invisible in the reply
- **02-6** [P3, test-gap] Wire agreement is pinned for element payloads only; fake-simd drifts from the Swift server
- **02-7** [P3, robustness, K9] Key-pacing env overrides are invisible to the TS typeText budget
- **02-4** [P3, robustness] An encode failure answers with id null, which the TS client discards

#### 03 · iOS TS driver (11: 0 P0, 0 P1, 8 P2, 3 P3) — `docs/audit/raw/03-ios-driver-ts.md`

- **03-1** [P2 ← P1, robustness] Socket client never recovers from a lost daemon; retryable E_HELPER_CRASHED burns every action timeout — 30000 ms/test (e) — needs device
- **03-5** [P2, robustness, K9] typeText timeout ignores the helper's pacing env and has no per-key slack; overflow types partial text — needs device
- **03-7** [P2, robustness, K16] simctl timeouts surface as non-retryable E_IO with no 'timed out' in the message
- **03-2** [P2, robustness] A silent socket waits 15 s, then a second helper is started next to the live daemon — 15000 ms/rep (e) — needs device
- **03-3** [P2, perf-latency, K7] Bridge-stale recovery shuts down the shared daemon; later spec processes start cold — 500 ms/test (e) — needs device
- **03-4** [P2, perf-latency, K7] Guest recycle sits on the launch critical path, after simctl launch — 1900 ms/rep (e) — needs device
- **03-6** [P2, flake-risk] Aborted driver calls keep running in the helper (no cancel) — needs device
- **03-8** [P2, robustness] Every FBSOpenApplicationServiceErrorDomain failure on launch/openurl is classed app unavailable — needs device
- **03-10** [P3, test-gap, K16] No record of where app.launch time goes; the smoke script cannot measure it or socket recovery — needs device
- **03-11** [P3, robustness] Client timer equals the helper's envelope timeout, so the helper's own timeout answer is always dropped
- **03-9** [P3, dx] toE2eError drops retryable and detail

#### 04 · Android warden-uiad (14: 0 P0, 0 P1, 9 P2, 5 P3) — `docs/audit/raw/04-android-uiad.md`

- **04-1** [P2 ← P1, robustness] A transient or unrecognised connect failure is persisted as uiadUnsupported and disables the server on that serial until the dex changes — 100000 ms/rep (e) — needs device
- **04-2** [P2, robustness] uiad-ops stops a healthy server on any non-refusal error it answered; a typeText that typed nothing is surfaced as a failed step
- **04-7** [P2, robustness] build.ts --out with no value (or .) recursively deletes the current directory
- **04-9** [P2, test-gap, K6] Java has no tests; the fake replays the first reply per op from one API 37 happy-path recording; wire agreement table
- **04-5** [P2, perf-latency] Edit quiet after typeText/key always costs the full 80 ms because server settle counts from the call; defer it to the next input — 1200 ms/rep (e) — needs device
- **04-6** [P2, flake-risk] Busy rule kills any warden-uiad, including one a live warden process (warden ui during warden e2e) is using — needs device
- **04-3** [P2, correctness, K6] fresh:true is a silent no-op below API 34 (UiAutomation.clearCache swallowed); reads on API 26-33 may come from the event cache — needs device
- **04-4** [P2, perf-latency, K6] Snapshot p95 tail: one getChild round trip per uncached node into the busy app UI thread; no miss counters, no prefetch strategy — 500 ms/rep (e) — needs device
- **04-8** [P2, perf-ram, K2] warden-uiad ~143 MB device RSS is VmRSS only: no PSS/private split, no VM options tried, 4-5 payload copies per reply — 0 MB (e) — needs device
- **04-12** [P3, dx] MIN_PLATFORM 30 cannot compile Uia.java (clearCache needs android.jar 34+); plan wire defaults differ from the Java
- **04-13** [P3, dx, K6] Wire fields dropped by the host (pkg 28% and order 7% of snapshot bytes) and K6 attribution fields (readMs, nodes, settle events, inject via) not on spans
- **04-10** [P3, correctness] ACTION_SET_SELECTION returns false when selection already matches: selectAll reports E_HID on a fully selected field, caretPlaced false on every recorded typeText — 300 ms/test (e) — needs device
- **04-11** [P3, correctness] scope:"all" switches interactive-window retrieval off before walking non-active windows, truncating them silently — needs device
- **04-14** [P3, perf-latency, K17] Every server start pays a separate dex-present shell round trip; fold it into the launch command — 15 ms/test (e) — needs device

#### 05 · Android TS driver (11: 0 P0, 1 P1, 6 P2, 4 P3) — `docs/audit/raw/05-android-driver-ts.md`

- **05-1** [P1, correctness] alert("accept") presses "Don't allow" on Android 11+ runtime-permission prompts — needs device
- **05-2** [P2, flake-risk, K17] Animation guard restores scales under a live driver; warden ui flips them every call — 150 ms/test (e) — needs device
- **05-3** [P2, robustness] waitForBoot spins 30 s on a given-up adb session and reports E_NOT_BOOTED — 30000 ms/test (e)
- **05-5** [P2, perf-latency] Transient null-root dump re-probes every route (~4.8 s/attempt x3) and can flip the saved route — 3800 ms/test (e)
- **05-7** [P2, test-gap] Fakes prefix-match whole ;-joined lines; real-process test never exercises the production open
- **05-4** [P2, perf-latency, K15] app.launch is force-stop + monkey (JVM start, no first-frame wait); use am start -W -n — 400 ms/test (e) — needs device
- **05-6** [P2, flake-risk] Fallback pressKeyRepeat batches up to 32 Backspaces with no gap (drops keys in RN) — needs device
- **05-11** [P3, dx] smoke-android.ts no longer smokes the production configuration (no uiad, no state) — needs device
- **05-10** [P3, correctness] Fallback tap({count:2}) is two slow single taps, not a double tap — needs device
- **05-8** [P3, correctness] key(name, modifiers) reports success on API <=30 where input keycombination does not exist — needs device
- **05-9** [P3, robustness] ;-joined lines mask failures: animation read/restore judged by the last command only

#### 06 · Screen: query & cache (11: 0 P0, 0 P1, 8 P2, 3 P3) — `docs/audit/raw/06-screen-query.md`

- **06-1** [P2 ← P1, flake-risk] Actions aim from a single fresh snapshot with no stability check: the mis-tap race is narrowed, not closed — needs device
- **06-3** [P2, correctness] The React tree match cache ignores input: a tap or boundingBox on a React-only match can use a rect up to 450 ms old, from before the last input
- **06-5** [P2, correctness] devtools.evaluate and reloadJs change the screen without moving the observation generation
- **06-6** [P2, correctness] Android: an alert button is pressed at a frame read from a kept snapshot up to 1 s old
- **06-2** [P2, perf-latency] Assert-then-tap is two snapshots: a snapshot stamped as quiet could let the action reuse the assertion's look — 3400 ms/rep (e) — needs device
- **06-4** [P2, perf-latency] Every no-match poll of a plain getByTestId action reads the React tree, including for actions that can never use it — 250 ms/test (e) — needs device
- **06-7** [P2, robustness] The reuse window is set per platform, not by read cost, and is counted from arrival: Android keeps a snapshot for 1 s while a read costs about 50 ms
- **06-8** [P2, flake-risk] Strictness throws on the first ambiguous poll of a wait: a transient duplicate during a transition ends the action — needs device
- **06-9** [P3, dx] locator("text=...") selectors are neither innermost-filtered nor ranked in specs, while warden ui ranks them
- **06-10** [P3, perf-cpu, K12] Query-layer CPU per read is sub-millisecond: the host CPU gap is not in the screen layer — 1 ms/test (e)
- **06-11** [P3, robustness] The kept snapshot survives attempt and test boundaries

#### 07 · Screen: actions & polling (11: 0 P0, 0 P1, 6 P2, 5 P3) — `docs/audit/raw/07-screen-actions-poll.md`

- **07-4** [P2, robustness] After the attempt deadline, fill's confirm loop spins with zero-length sleeps against the device
- **07-1** [P2, flake-risk] Actions tap where one snapshot says the element is, with no stability check — needs device
- **07-2** [P2, perf-latency] Assert-then-tap takes a second full snapshot on iOS where a hit-test would do — 1600 ms/rep (e) — needs device
- **07-3** [P2, flake-risk] tap({until}) re-sends blind after a fixed window: a double press when the first one landed late, ~4 s lost when it was dropped — 1000 ms/rep (e) — needs device
- **07-6** [P2, correctness] Secure fields are never verified after fill, though their dots are already counted — needs device
- **07-7** [P2, robustness] fill/clear/type/press tap a focus point that is never checked to be on screen
- **07-5** [P3, test-gap] fakeClock().sleep ignores the abort signal, unlike systemClock
- **07-8** [P3, perf-latency] .not matchers always hold a full 1 s; the planned early end on quiet did not land, and its stated reason is stale — 700 ms/test (e)
- **07-10** [P3, perf-latency] The Android setText op is implemented in warden-uiad but no TS code calls it — 60 ms/test (e) — needs device
- **07-9** [P3, perf-latency] The fill retry path waits a full second on a stable wrong value, then presses N+1 single-key RPCs on iOS — 900 ms/test (e)
- **07-11** [P3, flake-risk] Matchers and actions throw on several matches at once, with no poll for a transition to finish — needs device

#### 08 · Runner & session (10: 0 P0, 0 P1, 6 P2, 4 P3) — `docs/audit/raw/08-runner-session.md`

- **08-1** [P2 ← P1, flake-risk] A timed-out body or hook keeps running and drives the device during cleanup and the next test
- **08-2** [P2 ← P1, robustness, K5] Post-deadline work is not bounded by bun's 30 s margin; bun starts the next test while the old cleanup runs
- **08-3** [P2, correctness] Retries and same-title tests share one attempt dir: stale screenshots/failure files in a passed result, traces concatenated
- **08-4** [P2, robustness, K14] beforeAll/afterAll run outside any attempt: no deadline, no trace, no capture, and a throw writes no results lines
- **08-6** [P2, correctness, K14] Runner never marks or clears the devtools console/network ring per attempt
- **08-5** [P2, perf-latency] Failure capture is serial and never cancels its calls: up to 30 s per failing test, calls queued ahead of the next launch — 200 ms/test (e) — needs device
- **08-10** [P3, dx, K15] launch: "fresh" cannot wait for the app, so real suites opt out and relaunch by hand
- **08-8** [P3, robustness] Spans after flush() and buffered spans of a running step are lost on a late call or a kill
- **08-9** [P3, dx] Preload docs contradict behaviour: version check called a warning but exits 2; 'opens the session eagerly' does not open the driver
- **08-7** [P3, perf-latency, K1] Driver open happens lazily inside the first test's attempt, serial with spec collection and untraced — 300 ms/rep (e) — needs device

#### 09 · Device/app launch (11: 0 P0, 1 P1, 6 P2, 4 P3) — `docs/audit/raw/09-device-app-launch.md`

- **09-5** [P1, correctness] Android app.open() fails whenever WARDEN_LAUNCH_ARGS is non-empty (always with Metro --initialUrl) — needs device
- **09-2** [P2 ← P1, flake-risk] systemAlerts "dismiss" cancels the "Open in ...?" sheet, inside openLink({until}) and after it returns, and poisons the no-sheet memo — 6000 ms/test (e) — needs device
- **09-3** [P2, flake-risk] A sheet later than 1.2 s with the app in front is missed, and the no-sheet memo is never invalidated — 6000 ms/test (e) — needs device
- **09-6** [P2, robustness] Alert-read retries are counted in attempts, not time; openLink can overrun waitMs and throw
- **09-7** [P2, test-gap] Tests run every alert and link timing rule on a fake clock where reads cost 0 ms and frontmost ignores the sheet
- **09-1** [P2, perf-latency, K15] app.open({wait:"quiet"}) goes quiet on the launch screen; the settle is overlapped boot time, not a ready signal — 0 ms/test (e) — needs device
- **09-4** [P2, correctness] app.open({url}) on iOS skips the "Open in ...?" sheet handling — needs device
- **09-10** [P3, perf-latency] openLink({until}) polls at 250 ms after the hand-over and overshoots waitMs by up to one poll plus one look — 75 ms/test (e)
- **09-11** [P3, perf-latency] device.hideKeyboard() always takes a fresh full snapshot — 76 ms/test (e)
- **09-9** [P3, perf-latency] app.reinstall() probes installed twice — 150 ms/test (e)
- **09-8** [P3, perf-latency] app.clearData() on iOS is 7 serial xcrun simctl spawns — 600 ms/test (e) — needs device

#### 10 · Devtools facet (17: 0 P0, 1 P1, 12 P2, 4 P3) — `docs/audit/raw/10-devtools-facet.md`

- **10-1** [P1, flake-risk] Session turns lost after ~2 s and is never revived — needs device
- **10-2** [P2 ← P1, correctness] Network drain is destructive and shared; re-install ignores new config — needs device
- **10-10** [P2, robustness] Collector bookkeeping trusts a bare pid and is not stopped on release
- **10-7** [P2, perf-ram] Collector keeps host rings it never reads and writes one row per syscall batch — 10 MB (e)
- **10-8** [P2, perf-ram] Console lines are uncapped and stored twice (text and args) — 100 MB (e)
- **10-9** [P2, dx, K14] Console and network rings are not cut per attempt
- **10-11** [P2, correctness] Slow measurement yields silent not-found; max does not bound measure work — needs device
- **10-12** [P2, correctness] Network capture sees fetch only; XHR clients are invisible — needs device
- **10-13** [P2, perf-latency, K17] ui tree on Android opens the driver before the facet and defaults silently to scale 1 — 150 ms/test (e) — needs device
- **10-3** [P2 ← P1, perf-cpu] React-tree accelerator walks and measures the whole screen on every poll miss — 20 pct-cpu (e) — needs device
- **10-5** [P2, flake-risk] No deadline when waiting out a reconnect; stale page can be re-selected — needs device
- **10-6** [P2, perf-latency, K17] ui eval/tree/reload opens a full facet and patches the app's fetch — 50 ms/test (e) — needs device
- **10-4** [P2 ← P1, correctness] Android devtools target uses the AVD name; Metro reports the device model — needs device
- **10-15** [P3, robustness] Small session leaks: onCdp unsubscribe, polling-path results, ring slice
- **10-16** [P3, test-gap] Fakes cannot reproduce already-installed, shared-consumer or lingering-page shapes
- **10-17** [P3, correctness] logs start truncates the previous window's console and network files
- **10-14** [P3, perf-cpu] Idle 500 ms drain poll keeps the page busy when no sink reads it — needs device

#### 11 · Flows record/replay (17: 0 P0, 1 P1, 10 P2, 6 P3) — `docs/audit/raw/11-flows-record-replay.md`

- **11-2** [P1, correctness] Landmark check turns moved into absent so negative assertions pass falsely
- **11-1** [P2 ← P1, correctness] Recorded type and key steps are never exportable
- **11-3** [P2 ← P1, robustness] Append lock gives up before a dead holder lock is stale and stale-break races
- **11-10** [P2, robustness] export --ids rewrites the user ids module from scratch
- **11-11** [P2, robustness] Secret redaction covers exact matches only and skips get.expected
- **11-8** [P2, correctness] replay --from past the end passes with zero steps
- **11-9** [P2, correctness] update-snapshots does not refresh landmarks of wait is get scroll-until steps
- **11-5** [P2, perf-latency] Replay takes more snapshots per step than needed — 840 ms/rep (e) — needs device
- **11-6** [P2, perf-latency] Replay settle polls snapshots instead of driver.settle and ignores quietMs — 3500 ms/rep (e) — needs device
- **11-7** [P2, correctness] Android screen hash ignores static text so drift and settle are blind to text changes — needs device
- **11-15** [P2, flake-risk] Landmark tolerance fixed at 40 units and recordedOn unused at replay — needs device
- **11-12** [P3, perf-latency] Each append re-parses and re-serialises the whole flow — 2 ms/test (m)
- **11-13** [P3, dx] Flow v is a literal 1 with no migration path or helpful error
- **11-16** [P3, dx] Replay hides its own log lines
- **11-17** [P3, test-gap] No tests for flow-actors, lock races or sink-to-export
- **11-14** [P3, correctness] Export edge cases that produce a spec that does not parse or typecheck
- **11-4** [P3 ← P1, robustness] record start can overwrite concurrent state.json writes (helper record) — 500 ms/rep (e) — needs device

#### 12 · warden e2e setup (14: 0 P0, 1 P1, 8 P2, 5 P3) — `docs/audit/raw/12-cli-e2e-setup.md`

- **12-2** [P1, robustness] Auto-gc spawned just before the claim races the claim for idle booted sims — 20000 ms/rep (e) — needs device
- **12-1** [P2 ← P1, flake-risk] Late-window hide can reboot a sim under an already-warmed helper; jobs still get its socket — needs device
- **12-3** [P2, perf-latency, K7] Global readiness barriers: slowest device on any leg gates every job (warm 120 s, launch unbounded) — 1000 ms/rep (e) — needs device
- **12-5** [P2, robustness] Metro prewarm is not abortable: Ctrl-C or a failed claim waits for the cold bundle
- **12-8** [P2, dx, K10] slim: true makes --platform android refuse the whole suite (K10)
- **12-9** [P2, perf-latency, K5] Static round-robin shards: one device can idle while the other still has flows (K5) — needs device
- **12-4** [P2, perf-latency] slim waits behind the Metro await and the installs although it only needs a booted sim — 400 ms/rep (e) — needs device
- **12-6** [P2, perf-latency, K16] iOS openOnDevices: unbounded simctl launch on the critical path, then the spec relaunches anyway — 1000 ms/rep (e) — needs device
- **12-7** [P2, robustness] Android: a failed adb reverse only warns, and the device then runs every flow against an unreachable Metro — needs device
- **12-10** [P3, correctness, K14] A CLI --passes N bypasses the isolation rule: whole shards rerun, and passes share one out dir
- **12-11** [P3, robustness] Teardown runs its 15 s graces in series before the report; a second Ctrl-C does not escalate
- **12-12** [P3, perf-latency] One leg's failed claim does not stop the other legs' installs; the failure is reported only after them
- **12-13** [P3, correctness] --dry-run reports ok: true for a run that would be refused
- **12-14** [P3, dx] apps/example/warden.config.ts says example runs one spec process per flow; it runs one per device

#### 13 · warden e2e observe (9: 0 P0, 0 P1, 4 P2, 5 P3) — `docs/audit/raw/13-cli-e2e-observe.md`

- **13-1** [P2, robustness] TUI frame timer and hidden cursor not cleaned up when runGrid throws
- **13-3** [P2, correctness] --record: early-exiting recorder counts as started, missing marker costs 10 s, mid-run death unnoticed — 0 ms/rep (e) — needs device
- **13-2** [P2, perf-latency] Failure screenshot awaited inline, duplicates runner failure.png and shows end of shard — 300 ms/rep (e) — needs device
- **13-4** [P2, test-gap, K12] No bench or test measures the parent process; K12 12.1 percent excludes it — 0.3 pct-cpu (e) — needs device
- **13-5** [P3, perf-cpu] Results lines parsed 3 times and realpathSync uncached per result x flow in verdict pass — 7 ms/rep (e)
- **13-8** [P3, dx] tui.cast height fixed at first frame and live grid ignores terminal resize
- **13-6** [P3, perf-cpu] Parent still stamps every log chunk (plan says child) and drained polls every 10 ms — 10 ms/rep (e)
- **13-7** [P3, robustness] A failed log write ends the pump so the child pipe stops being read
- **13-9** [P3, robustness] Throwing sink in the poller timer becomes an unhandled rejection

#### 14 · warden ui agent CLI (14: 0 P0, 0 P1, 10 P2, 4 P3) — `docs/audit/raw/14-cli-ui-agent.md`

- **14-1** [P2 ← P1, flake-risk] Spawn deadline abandons a live, still-starting helper; warm path runs cold and collides with it — 4400 ms/test (e) — needs device
- **14-2** [P2 ← P1, robustness] Helper slow to send ready (2 s) treated as absent: second helper spawned beside it, old one never stopped — 4400 ms/test (e) — needs device
- **14-4** [P2, robustness] Signals sent to recorded helper/recorder pids without identity check (pid reuse)
- **14-6** [P2, robustness] state.json read-modify-write without lock loses helper/video/recording/collector records
- **14-7** [P2, perf-cpu] iOS video recorder outlives ui close, release and gc (orphaned simctl io recordVideo) — 0 pct-cpu (e) — needs device
- **14-9** [P2, perf-latency] --settle and wait stable poll full snapshots by hash instead of the driver's native settle — 100 ms/test (e) — needs device
- **14-10** [P2, cold-boot] AutomationEnabled probe/write runs serially after ensureHelper on ui and warm paths — 400 ms/rep (e) — needs device
- **14-3** [P2 ← P1, correctness] stopHelper is unarbitrated: a stop racing a spawn unlinks the new helper's socket and forgets its record — 4400 ms/test (e)
- **14-5** [P2, perf-latency] Resident helper replaced every run when owner key churns (user:<ppid>, CI run id) or helper path resolves differently — 2000 ms/rep (e) — needs device
- **14-8** [P2 ← P1, perf-latency, K17] Android: every warden ui call rebuilds the driver (adb shell, probe, animations off/on, uiad start/stop) — 450 ms/test (e) — needs device
- **14-11** [P3, perf-latency] swipe/scroll take a full snapshot only for the screen size; scroll --until snapshots again immediately — 65 ms/test (e)
- **14-13** [P3, test-gap] Helper race and leak paths untested; multi-process race test can pass without a collision
- **14-14** [P3, perf-latency] ui close --app spawns a helper only to terminate the app, then stops it; driver closed twice — 1000 ms/test (e)
- **14-12** [P3, perf-latency] Per-call fixed costs: git rev-parse spawn, unconditional last-snapshot zod parse, Android modules on iOS, double hash — 25 ms/test (e)

#### 15 · CLI startup & size (7: 0 P0, 0 P1, 4 P2, 3 P3) — `docs/audit/raw/15-cli-startup-size.md`

- **15-1** [P2 ← P1, perf-ram, K3] typescript bundled into every binary for __affected-graph only — 27.9 MB (m)
- **15-2** [P2, perf-latency, K4] run/dev/app import zod eagerly via ensure.ts, eas.ts, fingerprint.ts, dev.ts — 12.6 MB (m)
- **15-3** [P2, test-gap, K4] startup.test.ts lacks allowlists for run/dev/app/hook/devices/check/port
- **15-4** [P2, robustness] npm shim uses spawnSync and never forwards signals
- **15-5** [P3, perf-latency] root --help and help <cmd> load all 28 commands — 100 ms/rep (m)
- **15-6** [P3, robustness] deps.ts: download without timeout, from-source not idempotent, non-atomic swap
- **15-7** [P3, perf-latency] published e2e bundle unminified and loads zod at import — 10 ms/test (e)

#### 16 · Cold boot & leases (17: 0 P0, 2 P1, 10 P2, 5 P3) — `docs/audit/raw/16-core-cold-boot.md`

- **16-2** [P1, robustness] A device that never gets ready is neither quarantined nor retried, and is picked first again next time — 300000 ms/rep (e)
- **16-1** [P1 ← P0, flake-risk] Auto-gc started by a claiming command shuts down the idle device that same command is about to reuse — 6500 ms/rep (e) — needs device
- **16-4** [P2 ← P1, flake-risk] Android boot right after launch is a one-shot adb devices check that races adb registration — needs device
- **16-11** [P2, robustness, K16] No timeout on simctl boot/clone/create/list nor adb emu; a wedge hangs the claim and, under the golden lock, blocks everyone's clones for up to 40 min
- **16-5** [P2, cold-boot] Android readiness wait: 2 s poll, an untimed shell per read, and a dead emulator waited out for 300 s — 1000 ms/rep (e)
- **16-9** [P2, cold-boot] SessionEnd --shutdown shuts down every warden device the session held, not what the session booted — 7200 ms/rep (e)
- **16-10** [P2, robustness, K9] Probe time-outs under host load quarantine healthy sims for good, and a bad claim can run 3 cold boots (~100 s) — 15600 ms/rep (e) — needs device
- **16-12** [P2, cold-boot] slim costs ~1.6-2.7 s per fresh sim on the critical path, the benefit is unmeasured, and a plain claim re-arms the full cost — 1000 ms/rep (e) — needs device
- **16-13** [P2, cold-boot, K11] What keeps the second run of the day from starting warm: gc idle, helper idle, SessionEnd, and no pre-boot — 7000 ms/rep (m) — needs device
- **16-3** [P2 ← P1, cold-boot] Android: no warden-owned quick-boot snapshot; boot time and start state depend on the user's AVD — 25000 ms/rep (e) — needs device
- **16-6** [P2, cold-boot] Golden clones are serialised behind a 2 s-poll lock, with 3 serial pre-lock spawns and a full simctl list per device — 8000 ms/rep (e) — needs device
- **16-8** [P2, flake-risk] Headless hide: concurrent hides race on the global DetachOnWindowClose, and shut-down sims reboot one after another, unprobed — 6500 ms/rep (e) — needs device
- **16-14** [P3, perf-latency] Android claim spawns: emulator -list-avds twice per auto-profile create, and an untimed console call per running emulator per round — 250 ms/rep (e)
- **16-7** [P3, cold-boot] AutomationEnabled is not baked into the golden, so every fresh clone pays the in-sim defaults write — 400 ms/rep (m) — needs device
- **16-15** [P3, perf-latency] iOS boot path: simctl boot before bootstatus -b is a redundant spawn; the full probe right after bootstatus is ~2 more — 300 ms/rep (e) — needs device
- **16-16** [P3, dx, K9] defaultMax = floor(cores/4) <= 4 is CPU-only: 3 on the 14-core bench host, and blind to RAM — needs device
- **16-17** [P3, perf-cpu] Android launch argv omits cheap headless flags (-no-audio, -no-metrics), and AVD hw.* defaults go unchecked — needs device

#### 17 · Builds & install (15: 0 P0, 2 P1, 9 P2, 4 P3) — `docs/audit/raw/17-core-builds-install.md`

- **17-1** [P1 ← P0, correctness, K8] K8a: expo prebuild moves the native fingerprint mid-build; runLocalBuild refuses to cache, and re-keying alone still rebuilds for device 2 and other worktrees — needs device
- **17-2** [P1 ← P0, correctness, K8] K8b: locateArtifact only accepts outputs modified after the build start; up-to-date Gradle/Xcode runs find no artifact — needs device
- **17-4** [P2 ← P1, perf-latency] Per-device ensureApp has no in-process single-flight: failing builds/EAS lookups repeat N times, waiters sleep up to 2 s — 1000 ms/rep (e)
- **17-10** [P2, robustness] Legacy-cache import runs outside the build lock; concurrent devices race on rmSync + cp of one cache dir
- **17-11** [P2, robustness] Build cache is never pruned automatically; native+js caches a full build per JS change; installs are not prune-protected — 0 MB (e)
- **17-8** [P2, robustness] eas-cli calls and the Android APK download have no timeout while the build lock is held
- **17-9** [P2, robustness] adb install -r has no fallback for INSTALL_FAILED_UPDATE_INCOMPATIBLE / VERSION_DOWNGRADE — needs device
- **17-3** [P2 ← P1, correctness] iOS artifact search takes the newest .app across every DerivedData project; a parallel worktree's build can be cached under this key — needs device
- **17-5** [P2, perf-latency] PERF-4.6 fingerprint memo never landed: @expo/fingerprint runs on every ensure, now on the critical path with warm sims — 2500 ms/rep (e)
- **17-6** [P2, correctness] Android trusts the install record; a foreign install of the same package is never detected — needs device
- **17-7** [P2, correctness] iOS identity check runs 2 plutil per ensure, misses same-size JS changes; the post-install container path is discarded — 2 spawns/run (e) — needs device
- **17-12** [P3, perf-cpu] warden e2e --app evaluates warden.config.ts 3x and spawns git config for a project key specBundleId never uses — 15 ms/rep (e)
- **17-13** [P3, dx] warden app fingerprint fingerprints iOS then Android serially
- **17-14** [P3, robustness] Build-lock wait (90 min) is shorter than a legitimate holder (45 min EAS + 60 min build)
- **17-15** [P3, perf-cpu] Per-command git-facts memo expires after 5 s; clean/uninstall paths re-probe what confirm already saw — 2 spawns/run (e)

#### 18 · Store & affected (12: 0 P0, 2 P1, 5 P2, 5 P3) — `docs/audit/raw/18-core-store-affected.md`

- **18-1** [P1, correctness] changedFiles mixes repo-root and cwd-relative paths: untracked files vanish for a subdirectory config
- **18-2** [P1, robustness] isPortFree treats a code-less IPv6 bind error as busy: no port lease possible on IPv6-less hosts
- **18-3** [P2, perf-latency] computeAffected builds the import graph although a runAll hit makes it unreachable — 410 ms/rep (m)
- **18-4** [P2, perf-latency] Cold graph walk is about 400 ms, re-paid after every edit, import cache does not help — 300 ms/rep (e)
- **18-5** [P2, robustness] Crashed lease holder keeps device and ports until the 30 min TTL (dead pid + fresh heartbeat is alive) — needs device
- **18-6** [P2, robustness] Blocked BEGIN IMMEDIATE freezes the process for 15 s then throws inside the uncaught heartbeat timer
- **18-7** [P2, flake-risk] Retry runs on the same worker: one bad device spends every retry and drains the queue — needs device
- **18-10** [P3, robustness] Import cache written non-atomically and never pruned
- **18-11** [P3, perf-latency] warden e2e computes both platforms serially, then rejects the ambiguity — 800 ms/rep (e)
- **18-8** [P3, perf-latency] Warm affected path is 6 serial-ish git spawns plus sync content hashing of dirty files — 20 ms/rep (e)
- **18-9** [P3, perf-latency, K4] warden run / dev load the builds config schemas (zod) at registration, about 50 ms — 50 ms/rep (m)
- **18-12** [P3, correctness] Snapshot key can serve a stale graph (gitignored resolved files; edit during the walk)

#### 19 · Bench & suites (20: 0 P0, 0 P1, 16 P2, 4 P3) — `docs/audit/raw/19-bench-and-suites.md`

- **19-1** [P2 ← P1, robustness, K13] realExec timeout is not a bound when a grandchild keeps the pipes open
- **19-6** [P2 ← P1, perf-cpu, K12] Resources series averages over prepare, teardown and housekeeping; per-rep CPU-seconds missing
- **19-2** [P2 ← P1, robustness] Bench lease uses the 5-minute agent TTL and is never heartbeated
- **19-3** [P2 ← P1, flake-risk] Load gate runs before the app build, uses a 1-minute average vs core count, and is never recorded again — needs device
- **19-11** [P2, dx] Default 3 reps give n=2 warm: p95 is max, median is mean, stddev biased
- **19-12** [P2, dx] bench compare has no regression guard or comparability check
- **19-13** [P2, correctness] Non-finite stats written as 0 make regenerated reports show 0 ms for tests that never ran
- **19-7** [P2, perf-ram, K2] Per-process split of host RSS/CPU costs no extra spawn — 33 MB (m)
- **19-9** [P2, test-gap] Android residue is host-only and cannot see guest processes — needs device
- **19-14** [P2, perf-latency, K11] prepareMs includes a bun cli.ts process start, so the 300 ms target is unreachable by helper work alone — 140 ms/rep (e) — needs device
- **19-15** [P2, test-gap, K6] Android snapshotWarm target 800 ms predates warden-uiad and misses regressions — needs device
- **19-4** [P2, flake-risk] Fixed framework order puts warden first every run — needs device
- **19-5** [P2 ← P1, correctness, K12] ps %cpu is not the CPU used in the last tick on macOS — 0 pct-cpu (e) — needs device
- **19-8** [P2, test-gap] Emulator/CoreSimulator backend processes are in neither host nor sim series — needs device
- **19-10** [P2, perf-cpu] Sampler ps and adb top add unaccounted load; queued ticks bunch up — 5 pct-cpu (e) — needs device
- **19-16** [P2, perf-latency, K15] tap({until}) 4 s re-send window is headroom that inflates warm medians when a press is dropped — 1500 ms/rep (e) — needs device
- **19-19** [P3, robustness] Second SIGINT skips cleanup: lease and Android device settings left behind
- **19-17** [P3, perf-latency] Rep wallMs includes adapter post-processing and discards the adapter's own wall — 50 ms/rep (e)
- **19-18** [P3, flake-risk] warden ui bench taps screen centre so pressSettle depends on app state — needs device
- **19-20** [P3, flake-risk] With --retries N warden results hide failed attempts

#### 20 · Cross-cutting risk (11: 0 P0, 2 P1, 6 P2, 3 P3) — `docs/audit/raw/20-cross-cutting-risk.md`

- **20-1** [P1, flake-risk] Failed or skipped warm-up runs a second helper per job beside the resident one (two quiescence streams per sim) — 2200 ms/test (e) — needs device
- **20-2** [P1, correctness] SessionEnd (and /clear) releases a live run's leases and stops its helpers; holdLeases ignores heartbeat()'s 0 count
- **20-3** [P2, robustness] Recorded-pid kills have no identity check (helper SIGTERM, video SIGINT/SIGKILL, collector SIGTERM)
- **20-4** [P2, robustness] warden ui video start recorder outlives release, close, gc and SessionEnd
- **20-5** [P2, robustness] state.json read-modify-write is unlocked: parallel warden ui calls drop helper/video/collector/recording records
- **20-7** [P2, robustness] SIGHUP/SIGKILL of warden e2e/batch leaves detached group jobs and Metro running unsupervised; leases held 30 min
- **20-6** [P2, flake-risk, K17] Android: concurrent drivers on one serial kill each other's live warden-uiad as stale — 1900 ms/test (e) — needs device
- **20-8** [P2, correctness] Inherited WARDEN_SIMD_SOCKET reaches jobs of devices that did not warm; ready.udid never checked
- **20-10** [P3, robustness] warden install writes ~/.claude/settings.json non-atomically after a prompt
- **20-11** [P3, dx] A second Ctrl-C does not escalate; batch teardown can block ~45 s
- **20-9** [P3, robustness, K7] doctor --fetch-helper deletes the directory a resident helper runs from — needs device

#### 21 · Unit-test suite speed (12: 0 P0, 3 P1, 6 P2, 3 P3) — `docs/audit/raw/21-unit-test-suite-speed.md`

- **21-1** [P1, test-gap] commands/e2e.test.ts builds a git repo twice per test (beforeEach plus resuite)
- **21-2** [P1, dx] No package runs bun test --parallel; cli suite is serial at 56 s
- **21-4** [P1, test-gap] One root cause (18-2) fails 8 cli tests and 1 core test; port release NaN is a cascade
- **21-3** [P2, perf-latency] declarations.test.ts emits the same declarations twice (6.3 s)
- **21-5** [P2, test-gap] doctor everything-installed test is macOS-only but not marked or injected
- **21-6** [P2, robustness] realExec timeout does not bound the call when a descendant holds the pipes (dash sh -c sleep)
- **21-7** [P2, dx] Unit tests run only on macOS in CI so Linux-only failures are invisible
- **21-9** [P2, perf-latency] helper.integration.test.ts burns about 3.4 s of real waiting on non-injectable constants
- **21-8** [P2, flake-risk, K13] Wall-clock assertions with thin margins (ui close < 2.5 s vs 2 s wait) flake on loaded runners
- **21-12** [P3, dx] bare bun test in packages/e2e-bench picks up the Detox suite and fails 8 tests
- **21-11** [P3, dx] help.test.ts snapshot is 85 KB across 31 entries (churn on every flag change)
- **21-10** [P3, perf-latency] core/affected tests spawn a real worker bun and load TypeScript per case (about 10 s of 15 s)

### Known items (K1–K18) after the audit

- **K1**: 02-3 (known-extended), 08-7 (known-extended)
- **K2**: 19-7 (known-extended), 04-8 (new)
- **K3**: 15-1 (known-extended, P2)
- **K4**: 15-2 (known-extended), 15-3 (known-extended), 18-9 (known-extended)
- **K5**: 08-2 (new, P2), 12-9 (known-confirmed)
- **K6**: 04-9 (known-extended), 19-15 (new), 04-3 (known-extended), 04-4 (known-extended), 04-13 (known-extended)
- **K7**: 12-3 (known-extended), 01-2 (known-extended), 01-3 (known-extended), 03-3 (new), 03-4 (known-extended), 01-10 (known-extended), 20-9 (new)
- **K8**: 17-1 (known-extended, P1), 17-2 (known-extended, P1)
- **K9**: 03-5 (new), 16-10 (known-extended), 02-7 (known-extended), 16-16 (known-confirmed)
- **K10**: 12-8 (known-confirmed)
- **K11**: 16-13 (known-extended), 19-14 (known-extended)
- **K12**: 19-6 (known-extended, P2), 13-4 (known-extended), 19-5 (known-extended, P2), 06-10 (known-extended)
- **K13**: 19-1 (known-extended, P2), 21-8 (new)
- **K14**: 08-4 (new), 08-6 (known-extended), 10-9 (known-confirmed), 12-10 (known-extended)
- **K15**: 05-4 (known-extended), 09-1 (known-extended), 01-7 (known-extended), 19-16 (known-extended), 08-10 (known-extended)
- **K16**: 03-7 (known-extended), 16-11 (known-extended), 12-6 (known-extended), 03-10 (known-extended)
- **K17**: 05-2 (known-extended), 10-13 (known-extended), 10-6 (known-extended), 14-8 (known-extended, P2), 20-6 (known-extended), 04-14 (known-extended)
- **K18**: 01-1 (known-extended)

