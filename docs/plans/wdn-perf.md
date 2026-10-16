# WDN-PERF — warden performance audit + fixes (faster e2e start/run, less host CPU/RAM)

Plan ID: **WDN-PERF** · Branch `feature/warden-perf` (Orca workspace `warden-perf`, child of `e2e-bench`) stacked on `feature/e2e-bench` @ `1f329da` · PR → `feature/e2e-bench`.

## Rule 0: workspace + stacked branches (do this first, before any code)

1. Create a child Orca workspace nested under the e2e-bench workspace, based on `feature/e2e-bench`:
   ```bash
   orca worktree create --repo id:a3a2a741-0c71-4e4c-8b51-24ad36c526ea --name warden-perf \
     --base-branch feature/e2e-bench \
     --parent-worktree id:a3a2a741-0c71-4e4c-8b51-24ad36c526ea::/Users/chris/orca/workspaces/warden/e2e-bench \
     --comment "WDN-PERF: perf audit fixes, stacked on feature/e2e-bench" --json
   ```
   Then, in the new path: `git branch --show-current`. If it isn't `feature/warden-perf`, run `git branch -m feature/warden-perf`. Every later step runs in that worktree. Never `cd` back to e2e-bench.
2. Stack: `main` ← `feature/faster-local-e2e-runner` (PR #25) ← `feature/e2e-bench` ← `feature/warden-perf`.
   - `feature/e2e-bench` is **not on origin**, and GitHub can't stack a PR on a missing remote branch. Push it with `git -C /Users/chris/orca/workspaces/warden/e2e-bench push -u origin feature/e2e-bench`. **Don't open a PR for it** (user decision 2026-10-16).
   - Push `feature/warden-perf` the same way (`git push -u origin feature/warden-perf`).
   - The perf PR is always `gh pr create --head feature/warden-perf --base feature/e2e-bench`. Never base it on `main`.
   - If `feature/e2e-bench` moves: `git rebase --update-refs feature/e2e-bench`, then `git push --force-with-lease`.
   - When `feature/e2e-bench` merges, GitHub retargets the PR automatically once the base branch is deleted. Otherwise run `gh pr edit --base <new-base>`.
3. Subagent worktrees (`isolation: "worktree"`) branch from `feature/warden-perf`. The lead merges each issue branch back (`--no-ff`, one issue per merge).
4. Commits use the gitmoji format `<emoji> <type>(<scope>): … (PERF-x.y)`. **No `Co-Authored-By`, no Claude attribution** in commits or PR bodies (user rule overrides).
5. Devices: `warden` skill only. `warden claim ios|android --json`, then `warden release <leaseId>`. Subagents **never** run `warden release --mine`. Hold the Mac awake (`mcp__adrafinil__keep_awake`) during device runs. One `warden-simd` per sim. Bench runs only on an idle host, run by the lead, with nothing else running.

## Context

The iOS bench (`docs/bench/ios-2026-10-16.md`, `apps/docs/content/docs/bench/data/ios-2026-10-16.json`, raw data in `packages/e2e-bench/.bench/v1-ios-r2`) has warden at **101.9 s against agent-device's 97.8 s**. Warden loses on locked-account, valid-credentials and open-toggle (1.04–1.05×) and badly on deep-link (19.3 s vs 10.8 s, 1.79×). Other numbers:
- Step latency: median 91 ms, p95 2.76 s.
- Prepare: 729 ms (argent 98 ms).
- Host CPU: 9.4% avg (argent 1.2%).

Android (`.bench/smoke-android-r2`) is far worse: **warden 407 s against agent-device 104 s**.

Three parallel audits plus trace reading found that most of the gap comes from a few fixed costs. These costs are not inherent to the HID+AX design:

| # | Hotspot (evidence) | Cost/suite | Fix (issue) |
|---|---|---|---|
| 1 | iOS `fill` backspaces the **placeholder**. An empty RN field reports the placeholder as its value, with `placeholder:null` (`native/ios/Tests/warden-simdTests/Fixtures/sign-in.document.json`). That produces 16–22 Backspaces at ~78 ms each, and every fill takes 2.3–2.8 s whatever the text length. | ~22–24 s | PERF-1.1 |
| 2 | Settle after launch is pinned at **2.33 s** from test ~3 on, and the first read after each relaunch takes 1.3 s. The quiescence stream doesn't rebind to the relaunched app, so it gets stuck and settle falls back to snapshot comparison. `restart()` cancels the old stream without awaiting it, and two live streams stall each other. | ~18–25 s | PERF-0.4, PERF-1.2 |
| 3 | `device.openLink` always waits out `OPEN_LINK_WAIT_MS = 8000` when no "Open in…?" sheet appears (`device.ts:81,192-212`). It reads the alert every 100 ms, ~160 AX reads. | ~7.5 s | PERF-1.3 |
| 4 | Android: every snapshot is a fresh `uiautomator dump` with a ~1.9 s floor (new JVM plus `waitForIdle(1000)`). Every poll pays it, settle needs 2 dumps (3.85 s), and there's no reuse. | ~300 s | PERF-3.x |
| 5 | Post-launch `alert("dismiss")` does a double read (ax+axbridge) and runs into the relaunch repair. That's a 0.36 s gap per test. | ~3 s | PERF-1.4 |
| 6 | Prepare 729 ms: the helper spawns, the CLI polls the socket every 100 ms, connects, handshakes, closes, then the driver reconnects and handshakes again. The helper is also killed on every release. | 0.4 s/run | PERF-1.5 |
| 7 | Every locator read takes a new snapshot. The failure excerpt and descendant-text index are built on the success path too. Polling is a fixed 100 ms with no back-off. | CPU, 1–3 s | PERF-2.x |
| 8 | CLI cold start: all 28 commands and ora/clack/zod are imported eagerly (`warden version` 70 ms / 97 MB vs bare bun 10 ms / 23 MB). The binary is compiled without `--minify --bytecode`. There are ~20 git spawns per e2e run, redundant simctl/plutil/launchctl spawns, and setup phases run one after another. | 0.5–5 s/run | PERF-4.x |
| 9 | Parent process CPU: `flowPoller` re-reads and zod-parses the whole `results.jsonl` every second (quadratic), the TUI repaints at 10 fps, and the TypeScript compiler sits in the parent (92 MB) in diff mode. | host CPU/RSS | PERF-5.x |
| 10 | Observability gap: `trace.jsonl` has no `device.*`, locator reads or driver RPCs, so 35 s of the 102 s iOS rep (and 142 s of the 407 s Android rep) is untraced, and settle `via`/`reason` is dropped (`ios-driver.ts:244-247`). | blocks verification | PERF-0.2/0.3 |
| 11 | Bench fairness: the Android sampler regex misses the maestro and agent-device helpers, which biases the sim column against warden. Warden's Android driver sets animation scales to 0 and never restores them, which is residue and affects every framework after it. | report accuracy | PERF-6.1 |

Already fine, leave alone: sqlite store (WAL, busy_timeout, cached statements, short txns), no update check at startup, hand-written wire validator (no zod on snapshots), ~18 KB iOS snapshots (a server-side query isn't worth it), Android `input text` is a single call, iOS key pacing (hold 40 / pace 30 is the measured lossless floor for RN fields; **do not lower**).

**Principle:** fix the library, not the bench suite. `packages/e2e-bench/suites/warden/*` stays byte-identical for the headline re-run, so the speed-up is honest. New ergonomic APIs (PERF-2.4) get adopted in `apps/example/e2e` and the bench suite only after the headline re-run, and that adoption is benchmarked and reported separately.

## Targets (acceptance budgets, measured with the unchanged suite)

| Metric | Now | Target |
|---|---|---|
| iOS warm suite median | 101.9 s | **≤ 75 s** (≤ 0.8× agent-device) |
| iOS `fill` (email, empty field) | 2.75 s | ≤ 1.3 s |
| iOS settle after launch / first read after relaunch | 2.33 s / 1.3 s | ≤ 0.4 s / ≤ 0.3 s |
| iOS `openLink` without a sheet | 8.9 s | ≤ 1.5 s |
| iOS prepare | 729 ms | ≤ 300 ms |
| iOS host CPU avg / RSS avg | 9.4% / 116 MB | ≤ 5% / ≤ 110 MB |
| Android warm suite | 465 s, 91.7% pass (V2) | ≤ 250 s after PERF-3.1; **≤ 110 s, 100% pass** after PERF-3.3 (stretch: ≤ tester-army's 76 s) |
| `warden version` cold | 70 ms / 97 MB | ≤ 30 ms / ≤ 50 MB |
| Untraced time per rep | 35 s | ≤ 3 s |

## Baseline

| Platform | Run | Path | Warm suite |
|---|---|---|---|
| iOS | `v1-ios-r2` (3 reps, idle host) | `packages/e2e-bench/.bench/v1-ios-r2` | warden 101.9 s, agent-device 97.8 s |
| Android | `smoke-android-r2` (1 rep) | `packages/e2e-bench/.bench/smoke-android-r2` | warden 407.4 s, agent-device 104.5 s |
| Android | `v2-android-r2` (3 reps, `docs/bench/android-2026-10-16.md`) | `packages/e2e-bench/.bench/v2-android-r2` (e2e-bench worktree) | warden 465.0 s (91.7% pass, 8.3% flake), tester-army 76.4 s (100%), agent-device 46.2 s (83%), maestro 276.0 s |

### PERF-0.4 root cause: iOS settle stuck at 2.33 s, slow first read after relaunch (on device, `warden-iphone-17-5`, helper `WARDEN_SIMD_TRACE=1`)

Before = `warden` bench, 2 reps, head `3bbaee6`, host load avg 36 (`perf04-before`); after = 3 reps, PERF-1.2 (`perf04-after`), same device and app build. Per-test numbers are span details (`via`, settle ms, first snapshot ms) from `results.jsonl`.

| Metric | Before | After |
|---|---|---|
| Warm suite (median of reps) | 79.99 s (cold rep 75.01 s) | 62.92 s |
| settle after launch, median | 2329 ms (rep 1: 3 stream at 262-270 ms, 5 snapshot at 2305-2367 ms; rep 2: 8 snapshot) | 272 / 265 / 262 ms per rep |
| `via` per rep (stream / snapshot) | 3 / 5, then 0 / 8 | 5 / 3, 5 / 3, 5 / 3 (the 3 snapshot settles are 1.22-1.42 s, see 3 below) |
| First snapshot after launch | 430-600 ms | 6-95 ms |
| First `expect` of the next screen (`welcomeExpect`), median | 1443 / 1354 ms | 977 / 677 / 666 ms (includes the app drawing the screen: 31 ms when it was already up, 1.1-1.3 s when still booting) |
| Helper log, read path | 16 relaunches: 16 `did not respond ... opening a quiescence stream` warns, 29 `stream restart`, 13 `stuck for ... restarting it` | 25 binds: 25 with `restarts=0`, 0 such warns, 0 warn-level lines, 1 `stream failed` (the guest's own, debug level) |
| Relaunch probe (terminate + launch, no typing) | first read 1.6-1.7 s | 60 cycles: first read 21-90 ms (290-580 ms right after a guest reap), settle 253-380 ms except 5 wedge cycles at 1.24-1.30 s |

Root causes, in the order they cost time:

1. **First read races the stream.** A read made right after `simctl launch` reaches an app the stream has not bound: `E_APP_NOT_RESPONDING` in 16/16 relaunches. `recover` then restarted the stream (new guest ~0.18 s to open, first state 1.15-1.3 s later) and re-read: 1.6-1.7 s. The restart is unnecessary: the stream follows a relaunch by itself (`targetChanged(new pid)` then `state`) 0.25-0.4 s after the pid exists, bind ~0.7 s from launch (settle-first probe: bind 0.72-0.78 s, first read 30-90 ms, no failure). Fix: `rebind` on launch, `recover(pid:)` waits 900 ms for the stream to follow before restarting.
2. **Restarts raced themselves.** `restart()` did not await the old stream task (log: `stream ended` and `stream opening` in the same ms at all 29 restarts), so the old task's reset could clobber the new stream's state; `waitQuiet` read `state/pid/now` before the launchd pid lookup (150-350 ms under load) and restarted a stream that had followed during it (`frontmost 3660 is stale (target ...)` right after `targetChanged(new)`). Fix: awaited restart, state re-read after the lookup. No two stream guests were seen alive together (`ps` sampled every 30 ms).
3. **A wedged guest, the persistent 2.33 s.** The helper's long-lived guest (`SimulatorFrameworkBridge-iOS serve`, `.exclusive`, started with the helper) stops reporting quiet: every quiescence query answers `busy(runLoopIdle, animationsInactive)` for every process (SpringBoard and Settings too) until that process is ended. It survives any number of stream restarts, idle time, a replaced reader object (a new guest started, the old one stayed alive and stuck) and any number of client processes (it is helper-lifetime state; a fresh helper starts clean); ending the oldest guest restored `via:"stream"` in 5/5, 6/6 and 8/8 cycles afterwards. It is not typing (the probe never types), not the relaunch count, not failed reads: an idle probe (settle once a second, no relaunch) flips to `via:"snapshot"` at 26.5 s after the helper started; with relaunches the onsets were 21.4, 45.1, 67.6, 93.1 and 116.9 s after the stream first opened (22.6-25.5 s apart, every ~11 cycles). Cause inside the guest/idb not found. Fix: `reapWedgedGuests` ends the simulator's guests after a `snapshot` settle on guests that had reported quiet, then restarts the stream (5 reaps in 60 cycles, 9 in the 3-rep bench); a wedge now costs one ~1.25 s settle plus ~0.3 s on the next read instead of 2.3 s on every settle for the rest of the run.

Not done, and why:

- Plan item "dead old pid -> restart the stream at once" (PERF-1.2.3) is not implemented: a restart takes 1.15-1.3 s to its first state, the stream follows a relaunch itself in 0.6-0.7 s from launch, so restarting early is slower and churns guests. The first restart grace went 500 -> 900 ms instead.
- Targets not met yet: settle after launch is 262-272 ms median (<= 0.4 s) but 3 of 8 settles per rep still hit the wedge (1.2-1.4 s) because a guest wedges every ~24 s and a test takes ~8 s. Follow-ups: find the guest/idb cause, or recycle the guests before they wedge (~20 s of age, during `rebind`, saves ~1 s per wedge); `welcomeExpect` is dominated by the app's own render time once the first read is fast.

## Phases

### WDN-PERF-0 — setup, observability, root cause

**PERF-0.1 · `WDN-PERF 0 - 🔧 chore: child workspace, branch stack, plan copy`** (lead)
- Do Rule 0.
- Copy this plan to `docs/plans/wdn-perf.md`, add a row to `AGENTS.md`'s plan references if it has any, and commit `📝 docs(plan): WDN-PERF perf plan (PERF-0.1)`.
- Record the baseline run id `v1-ios-r2` and Android `smoke-android-r2` in the plan.

**PERF-0.2 · `WDN-PERF 0 - ✨ feat: trace spans for device calls, locator reads and driver RPCs`**
- Problem: `trace.jsonl` only gets `app.open`, locator actions/expects (`packages/e2e/src/fixtures.ts:28` → `session.step("locator", …)`) and fixtures/hooks. These are untraced:
  - `device.*` (`src/device.ts:168-280`: alert/settle/openLink/snapshot/hideKeyboard/back/home);
  - locator reads (`isVisible`/`text`/`count`/`value`/`isChecked`/`waitFor`, `src/screen/locator.ts:202-302`);
  - every driver call.
- Do:
  - Add a `span` event `{type:"span", ts, op, ms, ok, code?, detail?}` to `src/runner/trace.ts:8-19` (`traceEventSchema`).
  - Wrap the opened driver in a timing proxy in `src/session.ts:184-198`.
  - Add `step` to `FixtureSession` (`src/fixture-session.ts:9-22`) and wrap `device.*`.
  - Add a trace-only `read` span for locator reads.
  - Put adb command durations (`driver/android/adb-session.ts:191`) and the dump route into span `detail`.
  - Buffer span writes and flush at step end or on test end: no `appendFileSync` per RPC.
- Bench: `packages/e2e-bench/src/adapters/parse/warden-results.ts:22-29` keeps counting only `step-end` as steps. Add `untracedMs` per test (test wall minus the step and span union) to the results schema (`src/results/schema.ts`, bump the minor) and a report column.
- Tests first: a FakeDriver session emits spans with ops and durations; the parser fixture with spans; a golden update for the report.
- Accept: `bun run --cwd packages/e2e test`, `bun run --cwd packages/e2e-bench test`, typecheck and biome all green.

**PERF-0.3 · `WDN-PERF 0 - ✨ feat: surface settle via/reason/frontmostPid`**
- `src/driver/ios/ios-driver.ts:244-247` and `settleDataSchema` drop the helper's `{quiet, waitedMs, via, reason, frontmostPid}`. Keep them all.
- `driver/driver.types.ts` is frozen. Add an optional detail type next to it (pattern: `RepeatingKeys` in `src/driver/typing.ts:25-28`), or extend it and update `docs/plans/wdn-e2e.md` as `packages/e2e/AGENTS.md` requires.
- `device.settle()` returns the detail. The PERF-0.2 span records `via` and `reason`.
- Android `settle` reports `via:"hash"`.
- Tests first (`ios-driver.test.ts` with `native/scripts/fake-simd.ts`).

**PERF-0.4 · `WDN-PERF 0 - 📈 chore: device baseline + settle root-cause trace`** (one agent, one sim, after 0.2 and 0.3)
- Claim a sim and start the helper with `WARDEN_SIMD_TRACE=1`.
- Run `bun run --cwd packages/e2e-bench bench run --platform ios --frameworks warden --runs 2`, or `warden e2e example` against the bench build.
- Grep `~/.warden/simd/<udid>.log` for `stream restart`, `stuck`, `snapshot stability` and `did not respond`.
- Confirm or refute: (a) the stream doesn't follow the relaunched pid; (b) `restart()` overlaps two streams; (c) the jump starts after the first keyboard/secure-field test.
- Write the findings into `docs/plans/wdn-perf.md` § Baseline with per-op span stats. This gates PERF-1.2.

### WDN-PERF-1 — iOS hot path

**PERF-1.1 · `WDN-PERF 1 - 🐛 fix: fill clears with select-all, not placeholder backspaces`**
- Where:
  - `packages/e2e/src/screen/actions.ts:94-119`: `fieldValue` only drops the placeholder when `element.placeholder` is set, and iOS sends `null`. `clearKeyPresses` counts raw `element.value` for secure fields.
  - `src/screen/field.ts:95-104` (`focusAndClear`).
  - `src/driver/typing.ts:57-65` (`pressKeys`): iOS has no repeat fast path, so each Backspace is one `key` RPC (~78 ms).
  - `src/screen/locator.ts:549`: 4 confirm reads (`STALE_RISK_READS`) whenever `rawValue === text`, which fires when the typed text equals the placeholder.
- Do:
  1. Add an optional `SelectsAll` capability `{ selectAll(): DriverResult<void> }` plus a `canSelectAll` guard in `typing.ts`, mirroring `RepeatingKeys`/`canRepeatKeys`.
  2. Add a Swift `selectAll` op: a Cmd+A chord `chord(usage: 0x04, modifiers: [leftCommand])` next to `paste` in `native/ios/Sources/warden-simd/Ops/Keyboard.swift:133-144`. Add the wire type in `src/driver/ios/simd-protocol.ts` and a golden in `Tests/warden-simdTests/Fixtures`.
  3. `focusAndClear`:
     - when the field reads as non-empty: select-all + one Backspace;
     - secure fields count only bullets (`•`/`●`); any other value is the placeholder, so 0 presses;
     - skip clearing when the field is empty.
  4. `confirmFieldValue` stays the check. If attempt 2 mismatches, fall back to counted Backspaces (the current path).
  5. `STALE_RISK_READS` only applies when the field held the text before and was not showing its placeholder.
  6. Android: same capability via `input keycombination 113 29` + DEL on API ≥ 33. Otherwise keep `pressKeyRepeat` (`driver/android/android-argv.ts:89-95`, where batched keyevent 67 drops keys in RN).
- Tests first: an empty field with a placeholder value sends 0 Backspaces; a filled field sends selectAll + 1; secure placeholder → 0; mismatch → fallback; confirm read count is 2 for placeholder-equal text. Plus `swift test --package-path packages/e2e/native/ios`.
- Accept: on device, email fill ≤ 1.3 s, password ≤ 1.0 s, 0 lost characters over 25 fills (`native/scripts/smoke.ts`).
- Risk: RN `contextMenuHidden` or custom inputs refuse Cmd+A. The verify step and fallback cover that.

**PERF-1.2 · `WDN-PERF 1 - 🐛 fix: quiescence stream rebinds on app relaunch`** (after PERF-0.4)
- Where:
  - `native/ios/Sources/warden-simd/Ops/Settle.swift:353-374` (`QuiescenceMonitor.restart/recover`; `restart()` calls `task?.cancel()` then `start()` immediately);
  - `SettleJudge` (restarts a stuck stream at 1 s, falls back to snapshots at 2 s, plus 250 ms of frame stability, which gives 2.33 s);
  - `FrontmostGate` (500 ms grace, 1.5 s re-checks);
  - `Ops/Snapshot.swift:166-183` (`readRecovering` → `recoverBridge` → `recover(timeoutMs:4000)`);
  - `src/driver/ios/ios-driver.ts` ~386-390 (`app.launch` only sets `launchedBundle`).
- Do:
  1. Add a new `rebind{bundleId, timeoutMs}` op. The helper restarts the stream and waits for the first state on that bundle's pid. `ios-driver` `app.launch` calls it right after `simctl launch` returns.
  2. `restart()` awaits the old task's teardown before opening the new stream, so there are never two streams.
  3. `FrontmostGate`: when the old pid is dead, restart immediately (no 500 ms grace).
  4. Lower `fallbackAfterMs` from 2000 to ~700 as a safety net.
  5. Apply the PERF-0.4 findings if they point elsewhere.
- Tests: Swift unit tests for restart ordering with a fake stream; a TS test that launch issues `rebind` (fake-simd).
- Accept: settle after launch ≤ 0.4 s with `via:"stream"` in 8/8 tests across 3 reps; welcome expect ≤ 0.3 s; no `did not respond` lines in the helper log.

**PERF-1.3 · `WDN-PERF 1 - ⚡️ perf: openLink returns as soon as the app is frontmost`**
- Where:
  - `packages/e2e/src/device.ts:81-85` (`OPEN_LINK_WAIT_MS 8000`, `POLL 100`);
  - `src/device.ts:192-212` (with no sheet it returns only at the deadline);
  - `native/.../Ops/Snapshot.swift:452-471` (`alertButtons` reads the tree twice, ax then axbridge).
- Do:
  1. After `openUrl`, poll the alert at 100 ms for the first second, then every 250 ms.
  2. Return early once there has been no sheet for ≥ 1.2 s and the target bundle is frontmost. Get that from `settle{bundleId, quietMs:0}` `frontmostPid`, or from an app-tree hash change since before the `openurl`.
  3. Keep the full 8 s only while another app (SpringBoard/Safari) is frontmost.
  4. Memoise "scheme opened without a sheet" per session, so later calls skip the alert polling.
  5. Add `openLink(url, { until?: Locator, waitMs? })` (public API; update `src/index.ts` types and the docs).
  6. Add an `alertButtons{backend:"ax"}` mode for SpringBoard-hosted sheets.
- Tests (fake clock and FakeDriver): no-sheet path returns in ≤ 1.5 s of fake time; a sheet at 3 s is still accepted; a memoised scheme skips polling; `until` resolves early.
- Accept: deep-link test ≤ 11.5 s on device.

**PERF-1.4 · `WDN-PERF 1 - ⚡️ perf: cheap system-alert check`**
- Where: `device.alert()` in `src/device.ts` (`ALERT_READ_ATTEMPTS 5` × `ALERT_READ_RETRY_MS 300`; two full reads per call).
- Do:
  - Answer "is there a system alert?" from `snapshot.modal`, which every snapshot already returns (`Session.topmostModal`), or from an ax-only read.
  - Retry only when a modal is present but its buttons aren't readable yet.
  - Android: use `detectAlert` on the cached snapshot (PERF-2.1).
- Tests: no modal → 1 driver read and no sleeps.
- Accept: gap from `app.open` to the next step ≤ 0.1 s.

**PERF-1.5 · `WDN-PERF 1 - ⚡️ perf: helper starts once, connects once, stays resident`**
- Where:
  - `apps/cli/src/agent-ui/helper.ts:198-260` (`ensureHelper`: spawn, poll the socket every 100 ms, connect and handshake, close; then `openIosDriver` connects again);
  - `stopHelperAfter` in `apps/cli/src/lease-session.ts` (kills the helper on every release).
- Do:
  1. The helper prints a `ready` NDJSON line on stdout once the socket is listening, and the CLI awaits it (no polling).
  2. Hand the first connected client to the driver instead of reconnecting.
  3. Report ready before the quiescence stream is open (the first settle/rebind waits for it).
  4. On release, keep the helper and let `WARDEN_SIMD_STREAM_IDLE_S`/idle exit reap it. Stop it only on `--shutdown` or when the device lease passes to another owner (respecting the one-helper-per-sim rule).
  5. Import `agent-ui/close` dynamically inside `stopHelperAfter`.
- Tests: helper.test with a fake spawn emitting `ready`; single connect asserted.
- Accept: bench prepare ≤ 300 ms; back-to-back `warden e2e` runs reuse the helper (no spawn in the second run).

### WDN-PERF-2 — shared screen / runner layer (iOS + Android)

**PERF-2.1 · `WDN-PERF 2 - ⚡️ perf: observation cache + locator.read()`** (after PERF-1.1 merges)
- Where:
  - `packages/e2e/src/screen/context.ts:75-80` (`tryObserve`: a new `driver.snapshot()` and `indexSnapshot` on every read);
  - Android `driver/android/android-driver.ts:236-272` (only `elementAtPoint` has a 1 s cache) and `:386-389` (`alert()` dumps again).
- Do:
  1. Runtime-level cache keyed by an input generation. Any tap/type/key/swipe/app/openUrl/back/home bumps the generation.
  2. A max age per platform (iOS 150 ms, Android 1 s).
  3. Only the **first** poll of a read or assert may reuse; later polls read fresh.
  4. Field-confirm reads (`field.ts`) always bypass the cache. Today the Android confirm hits the 1 s cache and defeats its stale-read guard; fix that.
  5. Add `locator.read(): {visible, text, value, checked}` from one observation.
- Tests: consecutive `isVisible` and `text` → 1 snapshot; tap between them → 2; confirm never cached; age expiry.
- Accept: Android suite −30–60 dumps; iOS snapshot count per rep −20%.

**PERF-2.2 · `WDN-PERF 2 - ⚡️ perf: lazy failure excerpts and lazy subtree text`**
- Where:
  - `src/screen/locator.ts:578` (`pickOne` builds `rt.excerpt(observed.snapshot)` even for a single match; `excerpt` → `renderSnapshot` re-indexes, `render.ts:86`);
  - `src/expect/matchers.ts:307` (every failed poll);
  - `src/screen/locator.ts:557`;
  - `src/screen/nodes.ts:135-139` (eager `fragments`/`subtreeText`, O(nodes×depth), ~23 levels deep in RN).
- Do: pass a thunk and build the screen text only when an error is thrown. Compute subtree text on the first `textOf`/`hasText`.
- Tests: the excerpt function is not called on the success path (spy); error text unchanged (existing goldens).

**PERF-2.3 · `WDN-PERF 2 - ⚡️ perf: poll back-off + cheaper confirm`**
- `src/screen/poll.ts:26,67`: 100 ms for the first 1 s, then 250 ms. Keep it configurable and keep the deadline semantics.
- `src/screen/field.ts:16`: confirm `FIELD_POLL_MS` 100 → 50, preferring `hitTestField` (`field.ts:79`, ~10 ms) over full snapshots.
- `expect/matchers.ts` `NEGATION_GRACE_MS 1000`: keep the semantics, and end early once a settle reports `quiet` and the condition holds (document it).
- Tests: poll schedule under a fake clock; negation still holds for 1 s without settle.

**PERF-2.4 · `WDN-PERF 2 - ✨ feat: built-in retrying tap, quiet launch, auto system-alerts`** (API; adoption deferred to PERF-6.3)
- Today every suite hand-rolls `tapUntil`, `nextStep`, `launch()` (alert + settle) and `expectTodosAfterSignIn` (see `apps/example/e2e/helpers/flows.ts` and `packages/e2e-bench/suites/warden/helpers/flows.ts`). They cost 4 reads where 1 would do.
- Add:
  - `locator.tap({ until?: Locator | (() => Promise<boolean>), retries?, windowMs? })`, with one snapshot per poll;
  - `app.open({ wait?: "quiet" | "none" })`, which waits for the app to be frontmost and quiet via `rebind`/settle;
  - `test.use({ systemAlerts: "dismiss" | "accept" | "off" })`, which handles `snapshot.modal` inside polls already being taken.
- Public API: update `src/index.ts`, types, `apps/docs/content/docs` and the `warden` skill docs.
- Tests: FakeDriver equivalents of the helper tests in `suites/warden/helpers/flows.test.ts`.

### WDN-PERF-3 — Android

**PERF-3.1 · `WDN-PERF 3 - ⚡️ perf: Android quick wins`**
- Settle as a single dump:
  - `driver/android/android-driver.ts:370-384` and `driver/settle.ts:27-47`: hash settle needs ≥ 2 dumps (3.85 s), but each dump already waits for 1 s of idle;
  - with `nativeSettle:false`, one dump plus `quiet:true` is enough.
- Persist the dump route:
  - `android-dump.ts:15,76` probes `["stdout","tty","file"]` every process; `open.ts:38-47` never passes the remembered route (~2 s wasted per run);
  - store it per device serial in the warden store (or `$WARDEN_HOME/android/<serial>.json`) through the existing `onDumpRoute` hook, and try tty first on SDK ≥ 30.
- Add `-p <pkg>` to `openUrl` (`:181-183`).
- Restore animation scales on driver close if warden changed them (`:193-198`), recording the originals. Today this is residue.
- Tests: argv/unit tests with injected `Exec`.
- Accept: Android suite ≤ 250 s.

**PERF-3.2 · `WDN-PERF 3 - 📝 docs: resident UiAutomation server design spike`**
- Compare two designs:
  - (a) a small dex run with `app_process` inside the existing resident `adb shell`, speaking NDJSON over stdin/stdout. This is scrcpy-style: no APK install, no port forward. **Recommended.**
  - (b) an instrumentation APK + `adb forward`, as agent-device's `.SnapshotInstrumentation` and Maestro do.
- Questions to settle:
  - the UiAutomation single-client rule (one server per leased emulator; refuse a second);
  - hidden-API drift per API level;
  - how to build it (`d8` from the Android SDK build-tools; no Gradle in CI?);
  - packaging inside `@delacour/warden-e2e`;
  - `uiautomator dump` as the fallback.
- Prototype: time `getRootInActiveWindow` → JSON on the example app.
- Deliverable: `docs/plans/wdn-perf.md` § Android server, with the chosen design, wire protocol (mirror `simd-protocol.ts` shapes) and measured ms per snapshot.

**PERF-3.3 · `WDN-PERF 3 - ✨ feat: warden-uiad resident Android server`** (after 3.2)
- Location: `packages/e2e/native/android/` (source, `scripts/build.ts`, `scripts/smoke.ts`), plus a client in `src/driver/android/uiad-client.ts`. The Android driver uses it when available, with `uiautomator dump` as the fallback.
- Ops:
  - `snapshot` (windows + root, testID resource-id/tag mapping identical to today's `android-dump` normalisation);
  - `settle` from accessibility events, which sets `capabilities.nativeSettle = true`;
  - `setText` via `ACTION_SET_TEXT` for fill (verify and fall back to `input text`);
  - `health`.
- Tests: wire golden fixtures plus a fake server like `native/scripts/fake-simd.ts`. Never real adb in `bun test`.
- Accept: per-snapshot ≤ 150 ms; Android suite ≤ 110 s, 8/8 passing, 3 reps.

**PERF-3.4 · `WDN-PERF 3 - 🐛 fix: dismiss Android ANR dialogs`** (added by droid during PERF-3.1)
- Problem: a system "isn't responding" dialog during a run blocks every read. `ALERT_BUTTON_IDS` (`driver/android/`) has no ANR button ids.
- Do: capture a real ANR dump on a leased emulator first, then add `aerr_close` / `aerr_wait` (or whatever the dump shows) to `ALERT_BUTTON_IDS`, with a fixture test built from the dump.
- Accept: the fixture dismisses the ANR dialog; no id is guessed without a captured dump.

### WDN-PERF-4 — CLI / core startup and orchestration

**PERF-4.1 · `WDN-PERF 4 - ⚡️ perf: lazy command registry and lazy terminal UI`**
- Where:
  - `apps/cli/src/commands/registry.ts` (imports all 28 commands);
  - `apps/cli/src/context.ts` builds `terminalUi` (`src/ui.ts`: ora + @clack + chalk, 18 ms / 50 MB) for every command;
  - `release`/`gc`/`hook` pull in `agent-ui/close` → the e2e driver (28 ms / 69 MB).
- Do:
  - Registry entries `{name, summary, load: () => import("./x")}`. Load only `argv[0]`'s module, or all of them for `--help`/unknown.
  - Build ora/clack on first use.
  - Keep `--help` output byte-identical (snapshot test).
- Accept: `hyperfine 'bun apps/cli/src/cli.ts version'` ≤ 30 ms, max RSS ≤ 50 MB; `claim`/`heartbeat`/`hook` −40 ms.

**PERF-4.2 · `WDN-PERF 4 - ⚡️ perf: compiled binary with --minify --bytecode`**
- `apps/cli/src/update/source-build.ts:10-22` (`compileArgs`) and the npm build (`apps/cli/scripts/npm-packages.ts`): add `--minify --bytecode --sourcemap=linked`.
- Check Bun 1.3 `--bytecode` constraints (top-level `await`, ESM support).
- Keep `typescript` out of the startup parse (lazy `require` in `packages/core/src/affected/graph.ts:28-31`).
- Accept: compiled `warden version` measured before and after with hyperfine; the bundle test still passes.

**PERF-4.3 · `WDN-PERF 4 - ⚡️ perf: one git call per cwd`**
- Where:
  - `packages/core/src/owner.ts:55-61` (3 sequential git spawns);
  - `packages/core/src/project-key.ts:87-107` (3 more);
  - `packages/core/src/ensure.ts:44-60`;
  - `findSuite` in `affected.ts:53-55`.
  - About 20 spawns per e2e run in total.
- Do:
  - Use one `git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD`. Map `HEAD` to `""` on a detached HEAD; fall back to the old calls before the first commit.
  - Memoise per cwd on `CommandContext` (scoped per command for `warden serve`).
  - Route through the injected `Exec` (`packages/core/src/exec.ts`).
- Tests: owner/project-key with fake exec; detached and empty-repo cases.

**PERF-4.4 · `WDN-PERF 4 - ⚡️ perf: fewer spawns on claim and install`**
- `packages/core/src/builds/resolve.ts:92-108` → `install.ts:51-84`: pass the container path from `confirm` instead of calling `get_app_container` again; replace 4 `stat` spawns with an injected `fs.stat`; store the artifact identity at build time.
- `packages/core/src/providers/ios.ts:285-315` + `health.ts:59-68`: for an already-Booted reused device, skip `bootstatus -b` and `launchctl print system`; otherwise run them in parallel.
- `apps/cli/src/commands/claim.ts:30-44`: only restore slim when `DeviceRecord.slimmedAt` is set.
- `packages/core/src/sims/slim.ts`: about 80 serial spawns → concurrency 8.
- `apps/cli/src/sim-windows.ts`: `pgrep -xq Simulator` guard; skip the second `hideSimWindows` (`claim-flags.ts:174`, `batch.ts:1416`) when nothing booted in between.
- Tests: fake `Exec` asserting spawn counts.

**PERF-4.5 · `WDN-PERF 4 - ⚡️ perf: parallel e2e setup`**
- `apps/cli/src/batch.ts:1401-1418` (`supervise` runs Metro → `preparePools` → `openOnDevices` → hide → `warmStep` in series): warm drivers right after the claim, alongside Metro and install; run hide and `openOnDevices` in parallel; skip `openOnDevices` for the release variant (each test relaunches anyway).
- `apps/cli/src/lease-session.ts:325-346` (`claimLegs`): `Promise.all` the legs and install per leg.
- `apps/cli/src/metro.ts:40`: `READY_POLL_MS` 500 → 150; run `node_modules/.bin/expo` directly instead of `bunx expo` (as `findFingerprintBin` does).
- `apps/cli/src/commands/dev.ts:104-117` (`devScheme` runs `bunx expo config --json` for 1–3 s): skip it on iOS, or run it alongside the claim.
- Tests: batch deps fakes asserting concurrency (start-order timestamps).

**PERF-4.6 · `WDN-PERF 4 - ⚡️ perf: cheaper build fingerprint`**
- `packages/core/src/builds/fingerprint.ts:71-118` (`computeCacheKey` runs `@expo/fingerprint` and then `jsInputsHash` serially); `js-inputs.ts` reads files serially.
- Do:
  - Run native and JS hashing with `Promise.all`.
  - Use the `git ls-files -s` blob ids for tracked clean files; hash only dirty and untracked files.
  - Memoise in the builds table keyed by HEAD + dirty set + lockfile hash + `app.config.*` env inputs.
- Risk: medium (a cache miss is fine, a false hit is not). Add tests for untracked files, an env-reading config and a lockfile change.

**PERF-4.7 · `WDN-PERF 4 - ⚡️ perf: one spec process per device`**
- `apps/cli/src/commands/e2e.ts:422-441` (`jobPlan` spawns one `bun test` per flow file, ~150–250 ms each: bun start, preload, driver connect, plutil).
- Default to one process per device running its flows in order. Keep `e2e.isolate: "flow"` in `warden.config.ts` as opt-in.
- Results, JUnit and per-flow logs stay per flow (the runner already writes per-test dirs).
- Tests: `jobPlan` unit tests for both modes; a crash in device mode marks the remaining flows `missing`/`failed` correctly.

**PERF-4.8 · `WDN-PERF 4 - ⚡️ perf: keep sims booted while idle locally`** (approved)
- `apps/cli/src/commands/e2e.ts` `shutdownIf` (~353) + `shutdown-policy.ts`: a passing local gate shuts the sims down, so the next run cold-boots (10–30 s).
- Locally, leave them booted and let gc's `DEFAULT_IDLE_MS` (20 min) / `STALE_SHUTDOWN_GRACE_MS` reap them. CI keeps shutting down.
- Config `e2e.shutdown: "always" | "idle"`.

### WDN-PERF-5 — host CPU / RAM while running

**PERF-5.1 · `WDN-PERF 5 - ⚡️ perf: quiet parent process`**
- `apps/cli/src/batch.ts:585-622` (`flowPoller`): track a byte offset per `results.jsonl` and parse new lines once. Today it does a full re-read, 2 parses and a zod `safeParse` per line every second, which is quadratic.
- `batch.ts:215` (`FRAME_MS 100`): render at 1 Hz plus on events.
- `batch/stamped-log.ts`: children stamp their own lines (`WARDEN_LOG_STAMP=1` in the spec env); the parent pipes bytes straight through. Review `LOG_DRAIN_MS 2000`.
- Accept: bench host CPU avg ≤ 5% for a `warden e2e example` run (sampler from `packages/e2e-bench/src/harness/sampler.ts` reused via a small script).

**PERF-5.2 · `WDN-PERF 5 - ⚡️ perf: TypeScript graph out of the parent`**
- `packages/core/src/affected/graph.ts:28-31` (`loadTs`, 91 ms / 92 MB held for the whole run in diff mode).
- Build the graph in a `bun` subprocess that returns JSON, and cache it under `$WARDEN_HOME/affected/<HEAD>-<dirtyHash>.json`.
- Tests: the cache hit path skips the spawn.

**PERF-5.3 · `WDN-PERF 5 - ⚡️ perf: background housekeeping`**
- `apps/cli/src/autogc.ts`: check cheaply for stale leases (sqlite query) before spawning a full `warden gc` (~100 MB), and spawn it under `nice -n 10`.
- `apps/cli/src/commands/gc.ts:54-58`: shut idle devices down in parallel.
- `packages/core/src/store.ts`: `PRAGMA synchronous=NORMAL` (safe under WAL).
- Tests: autogc with no stale leases → no spawn.

### WDN-PERF-6 — bench fairness, verification, report

**PERF-6.1 · `WDN-PERF 6 - 🐛 fix(bench): fair Android sampling and no animation-scale carry-over`**
- `packages/e2e-bench/src/harness/sampler.ts:48,146,155-159`: case-insensitive regex that also matches `dev.mobile.maestro`, `com.callstack.agentdevice` and `SnapshotInstrumentation`, plus the future `warden-uiad`.
- Track pid start times so a reused pid isn't miscounted.
- `harness/isolation.ts`: reset animation scales between frameworks.
- Tests: sampler fixtures (`harness/fixtures/adb-top.txt`).

**PERF-6.2 · `WDN-PERF 6 - 📝 docs: re-run benchmarks + publish`** (lead; idle host; nothing else running)
- `bun run bench run --platform ios --runs 3` and `--platform android --runs 3`, with the suite unchanged.
- `bun run bench compare .bench/v1-ios-r2 .bench/<new>`.
- Write `docs/bench/ios-<date>.md` / `android-<date>.md`.
- `bun run bench summary <runDir> --out apps/docs/content/docs/bench/data/<platform>-<date>.json`; update the docs comparison page.
- Record the results against the Targets table in `docs/plans/wdn-perf.md`.

**PERF-6.3 · `WDN-PERF 6 - ♻️ refactor: adopt the new APIs in example + bench suites`** (after 6.2)
- Replace the hand-rolled helpers in `apps/example/e2e/helpers/flows.ts` and `packages/e2e-bench/suites/warden/helpers/flows.ts` with the PERF-2.4 APIs. Keep the same retry semantics, which is the bench parity rule in `packages/e2e-bench/AGENTS.md`, and document it in the bench README.
- Re-run the warden-only bench and report it as a separate "idiomatic warden" row. The headline comparison stays the unchanged suite.

## Implementation team (≥ 5 per wave, `isolation: "worktree"` from `feature/warden-perf`; the lead integrates)

| Agent | Role | Issues |
|---|---|---|
| lead | integrate, device baseline, bench, PRs | 0.1, 6.2 |
| tracer | runner trace and bench parser | 0.2, 0.3 |
| typist | fill/select-all (TS + Swift) | 1.1 |
| linker | openLink + alerts | 1.3, 1.4 |
| streamer | quiescence stream (Swift), root cause | 0.4, 1.2 |
| helper | warden-simd lifecycle and prepare | 1.5 |
| poller | screen layer CPU | 2.2, 2.3 |
| cacher | observation cache + new APIs | 2.1, 2.4, 6.3 |
| droid | Android quick wins | 3.1 |
| droid-arch | Android server spike, then build | 3.2, 3.3 |
| starter | CLI cold start | 4.1, 4.2 |
| spawner | git, claim and install spawns | 4.3, 4.4 |
| conductor | orchestration, fingerprint, process model | 4.5, 4.6, 4.7, 4.8 |
| quiet | parent CPU/RAM, housekeeping | 5.1, 5.2, 5.3 |
| referee | bench fairness | 6.1 |

Waves:
- **W0:** lead runs 0.1.
- **W1:** no devices, all parallel, 12 agents: tracer (0.2, 0.3), typist (1.1), linker (1.3, 1.4), helper (1.5), poller (2.2, 2.3), droid (3.1), droid-arch (3.2 spike: one emulator lease), starter (4.1, 4.2), spawner (4.3, 4.4), conductor (4.5, 4.6), quiet (5.1, 5.2, 5.3), referee (6.1).
- **W2:** 6 agents, one device lease each, released by lease id: streamer (0.4 → 1.2), cacher (2.1, 2.4; after 1.1 merges), droid-arch (3.3), conductor (4.7, 4.8), typist (on-device verification of 1.1: 25-fill loss check), linker (on-device verification of 1.3).
- **W3:** lead only, idle host: merge, full test suites, 6.2. Then cacher runs 6.3, and the lead opens the stacked PR.

## Verification

- Per issue (TDD): `bun run --cwd packages/e2e test` (always the package script, not root `bun test`), `swift test --package-path packages/e2e/native/ios`, `bun run --cwd packages/e2e-bench test`, `bun run --cwd apps/cli test`, `bun run --cwd packages/core test`.
- Then `bun run typecheck && bun run check`. Prefer call-count and fake-clock assertions over wall-time asserts.
- Swift changes: `bun run --cwd packages/e2e native:build`, then `dist/warden-simd --health --udid <udid>` (expect `ax.bridge=available`), then `bun native/scripts/smoke.ts --udid <udid>` on a leased sim (also with `--kill-bridge` / `--kill-helper`).
- End to end:
  - `warden e2e example` on a claimed sim: 8/8 pass, `trace.jsonl` spans show settle `via:"stream"` and fills ≤ 1.3 s.
  - Then PERF-6.2 benches (3 reps, idle host, caffeinated) checked against the Targets table.
  - `hyperfine` for CLI start.
  - Bench resource columns for host CPU/RSS.
- Regression guard: `bun run bench compare <baseline> <new>` must show no per-test regression > 5% before the PR is marked ready.

## Follow-ups (reported by agents, not yet scheduled)

| From | Follow-up |
|---|---|
| poller (2.3) | CLI `ui wait` (`apps/cli/src/agent-ui/query.ts`) still polls at a fixed 100 ms; move it to `screen/poll.ts`'s back-off. |
| spawner (4.3) | Wire the per-command git facts cache into `claim-flags.ts` / `port.ts`. Other git spawns remain: `builds/local.ts:120`, `batch.ts:1483`, `affected/git.ts`, `cleanHead`. |
| starter (4.1) | `gc` still loads heavy modules; `ui`/`run`/`dev`/`batch`/`e2e` load the driver eagerly. Compiled binary is 116 MB, mostly `typescript` bytecode. |
| quiet (5.2) | A compiled binary has no `graph-worker.ts` on disk, so diff mode falls back to the in-process graph. Fix with a hidden `warden` subcommand or an embedded worker. |
| typist (1.1) | iOS plain fields showing a placeholder still get selectAll + 1 Backspace; `ada@example.com` keeps 4 confirm reads. |
| referee (6.1) | One bench test failed once under load and passed in 6 later runs: watch for a timing flake. |

## Decisions (user, 2026-10-16)

| # | Question | Answer |
|---|---|---|
| 1 | Android scope | Build the resident server in this plan: PERF-3.1, then 3.2, then 3.3. |
| 2 | Default changes | All three approved: one spec process per device (PERF-4.7, `isolate:"flow"` opt-in); keep sims booted when idle locally (PERF-4.8, CI still shuts down); keep `warden-simd` resident after release (PERF-1.5). |
| 3 | PR shape | One stacked PR: `feature/warden-perf` → `feature/e2e-bench`. |
| 4 | Base branch | Push `feature/e2e-bench` to origin, but open no PR for it. |

## Unresolved questions

None.
