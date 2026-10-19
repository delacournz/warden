# WDN-PERF Wave 1: correctness and flake fixes from the e2e audit

> Status: implemented and unit-verified in a Linux container (no simulator or emulator); the device checklist below is open. The PR stays a draft until it has run. Implements "Wave 1" of the overnight performance and robustness audit (report: `docs/audit/wdn-perf-audit-2026-10-16.md` in PR #31; finding ids below refer to its raw files `docs/audit/raw/<nn>-*.md`).

## Context

The audit (21 agents, 263 findings, 40 P0/P1 items adversarially verified) ranked the fixes into three waves. Wave 1 is the set that needs no device to implement and test: build-cache correctness on fresh checkouts, the auto-gc/claim race, iOS helper lifecycle arbitration, lease liveness and `/clear` semantics, Android launch args, runner deadline hygiene, and the tap-stability flake class. Policy decisions were taken in the morning interview and are recorded in the report's section 9 ("Decisions recorded").

Decisions that shape this wave:

| Decision | Choice |
|---|---|
| Contract changes | Additive only: new optional fields, flags and appended nullable migrations; no removals or renames |
| `/clear` and SessionEnd (20-2) | Runs abort on a zero-row heartbeat; SessionEnd with `reason: "clear"` keeps leases whose pid is alive |
| CNG build cache key (17-1) | Cache under the requested (pre-prebuild) key and alias the post-build key when the native dir did not exist before the build and the JS half is unchanged |
| `warden ui` on a device another run leased (04-6, 05-2, 20-6) | Refuse with a message naming the owner and pid unless `--force` |
| Helper replacement (14-5) | Key on the helper binary and `WARDEN_SIMD_*` env, not on owner identity |
| Lease liveness (18-5) | Dead pid wins for supervised leases (three heartbeat periods of grace); pid-less leases keep the TTL |
| Flake-class Wave 2 items | 06-1/07-1, 07-3 and 09-2 join this wave |
| Warm pool | Fix the race and SessionEnd only; `warden warm` stays a proposal |
| Android quick-boot snapshot (16-3) | On by default when it lands (Wave 2/3, device-verified) |

## Clusters

One agent per cluster, each in its own git worktree off this branch, merged by the orchestrator.

| Cluster | Findings | Main files |
|---|---|---|
| builds | 17-1, 17-2, 17-3, 17-4 | `packages/core/src/builds/{local,ensure,cache,resolve}.ts` |
| gc-claim | 16-1/12-2, 16-2, 16-4 | `apps/cli/src/{autogc,commands/gc,commands/claim}.ts`, `packages/core/src/{claim,allocate,providers/ios,providers/android}.ts` |
| helper-cli | 14-1, 14-2, 14-3, 14-5 | `apps/cli/src/agent-ui/{helper,state}.ts` |
| ios-client | 03-1, 20-1 | `packages/e2e/src/driver/ios/*.ts`, `apps/cli/src/batch/warm-drivers.ts`, `apps/cli/src/e2e/warm-connect.ts` |
| leases | 20-2, 18-5 | `apps/cli/src/lease-session.ts`, `apps/cli/src/hooks/claude-pretool.ts`, `packages/core/src/{liveness,store}.ts` |
| ui-guard | 04-6, 05-2, 20-6 (refusal) | `apps/cli/src/commands/ui.ts`, `apps/cli/src/device-lease.ts`, `apps/cli/src/agent-ui/target.ts` |
| e2e-lib | 09-5, 04-1, 11-2 | `packages/e2e/src/app.ts`, `packages/e2e/src/driver/android/uiad-backend.ts`, `packages/e2e/src/flows/*.ts` |
| runner | 08-1, 08-2, 10-1 | `packages/e2e/src/runner/*.ts`, `packages/e2e/src/{session,fixtures}.ts`, `packages/e2e/src/devtools/session.ts` |
| tap-flake | 06-1/07-1, 07-3, 09-2 | `packages/e2e/src/screen/locator.ts`, `packages/e2e/src/driver/observation-cache.ts`, `packages/e2e/src/{device,device-link}.ts` |
| small-fixes | 18-1, 18-2, 19-1, 15-3, 13-2 | `packages/core/src/affected/git.ts`, `packages/core/src/ports.ts`, `packages/e2e-bench/src/harness/exec.ts`, `apps/cli/src/startup.test.ts`, `apps/cli/src/e2e/verdicts.ts` |

## Results

Ten clusters, one squashed commit each (`git log --oneline main..claude/wdn-perf-wave1`). Every item started from a failing test. Verification on the integrated branch: root typecheck 9/9, biome clean (warning counts unchanged), `packages/core` 696 pass, `packages/e2e` 1840 pass, `apps/cli` 1386 pass / 3 todo / 1 fail (`warden doctor` all-ok row, which needs the macOS sim helper; it fails on `main` in this container too), `packages/e2e-bench` 357 pass. Two container-bound failures from `main` are gone (IPv6-less port probe, bench exec timeout).

| Cluster | Status | What changed | Left out or follow-up |
|---|---|---|---|
| builds | 17-1, 17-2, 17-3, 17-4 done | `runLocalBuild` accepts a prebuild key move (native dir new, JS half unchanged) and returns `postKey`; `ensure` stores under the requested key, aliases the post-build key (a 0 B `builds` row) and records the install under it; artifact fallback to the newest older output after the key check, never `androidTest`, iOS bundle id must match; DerivedData filtered by `WorkspacePath`; same-process single flight per build key | Shorter foreign poll; alias rows show 0 B in `builds ls` |
| gc-claim | 16-1/12-2, 16-2, 16-4 done | `maybeAutoGc` runs after the claim in claim/run/dev/batch; gc re-checks each device under `store.transaction` and holds a 2 min `gc-shutdown` lease during the shutdown; `Shutting Down` maps to `shutdown` and iOS `boot` waits it out (≤ 30 s); a `waitReady` failure quarantines/skips like a failed probe; Android `boot` polls `adb devices` ≤ 15 s for a just-launched serial | Optional shorter ready budget for reused devices; log wording still says "health probe" |
| helper-cli | 14-1, 14-2, 14-3, 14-5 done | one spawner waits ≤ 15 s on something live and stops its child on failure; no socket file = spawn without a probe; handshake timeout with a live pid = busy (wait, replace after 5 s); `spawnHelper` refuses a second helper; `stopHelper` takes the spawn row, unlinks only the same socket file, forgets only its own record; replacement keyed on binary realpath+mtime and `WARDEN_SIMD_*` env hash, never under the current lease | 14-4 pid identity check (more exposure now that a refusing helper is stopped); a spawner that crashes mid-start still allows a second helper |
| ios-client | 03-1, 20-1 done | `E_HELPER_CRASHED` replaces the helper once (socket first, else stdio) and retries reads; input errors unchanged; a failed replacement fails fast; a silent configured socket is retried once after 500 ms; a failed warm-up stops the resident helper; `--no-warm` hands a recorded live helper's socket to the jobs | |
| leases | 20-2 (a)(b), 18-5 done | `holdLeases` beats at start and aborts the run (SIGTERM path, exit 130) when a beat updates fewer rows; `/clear` keeps leases whose pid is alive and heartbeat fresh; appended migration `leases.heartbeat_ms`; a supervised lease with a dead pid is stale three periods (90 s) after its last beat | Period recorded when `holdLeases` starts, not at claim (a crash between claim and supervise still waits the TTL); pid reuse not handled |
| ui-guard | refusal + `--force` done | `ensureCallerLease({ exclusive })` returns `device_busy` (exit 2) when the caller's own lease is held by another live pid (a running e2e/batch/run/dev); every `warden ui` subcommand except `status`; `--force` keeps today's behaviour; docs and skill reference updated | Android `warden-uiad` owner arbitration (04-6, 20-6) and the animation owner record (05-2) stay proposals; two parallel `warden ui` calls from one agent are unguarded (agent leases carry no pid) |
| e2e-lib | 09-5, 11-2 done; 04-1 TS half | Android `app.open()` drops `WARDEN_LAUNCH_ARGS` (one stderr line; explicit args still fail); `connect_failed` persisted only after two consecutive failed starts; replay `find` returns `{ resolved, moved }` and `wait`/`is`/`get`/`scroll` use the element, with a `moves` list on the outcome | Java classifier (`connect_error`), 24 h stamp (strict state schema), `warden ui flows replay` does not print `moves` |
| runner | 08-1, 08-2, 10-1 done | `attemptSession` binds fixtures to their attempt; identity-checked `enterAttempt`/`leaveAttempt`; one post-deadline budget (bun margin minus 5 s) shared by capture, hooks and teardowns, snapshot skipped after a screenshot timeout, late `test.use({ timeout })` warned; devtools reconnect 30 s time-based with backoff, `lost` revivable, the session drops a lost facet | `expect.soft` and `traceDriver` still read the global slot; a dead Metro takes ~30 s to report `lost` |
| tap-flake | 06-1/07-1, 07-3, 09-2 done | actions accept a frame only when it held still across two looks of the same generation (free with a kept snapshot; one extra look within 300 ms of an input; cap 2); `tap({ until })` never re-presses once the screen changed and re-presses at ~750 ms when unchanged; the "Open in …?" sheet is left to `openLink` while a link is in flight and answered with Open under `dismiss` | `until` read inside `openLink` can still see the target behind a sheet not yet seen |
| small-fixes | 18-1, 18-2, 19-1, 15-3, 13-2 done | `ls-files --full-name`; `classifyBindError` (IPv6-less hosts can lease ports); bench `realExec` detached + process-group kill + bounded drain; cold-start table test (run/dev/app as todo for 15-2); runner `failure.png` replaces the batch screenshot for failed flows | Timed bench children no longer get the terminal's Ctrl-C directly |

Behaviour changes a user can notice: a `/clear` leaves a running run's leases alone; `warden batch`/`e2e` stop with exit 130 and a named cause when their leases vanish; `warden ui` on a device a run drives exits 2 unless `--force`; a broken `warden-simd` spawn fails after 15 s instead of 5 s; `tap({ until })` re-sends at ~1 s instead of 4 s and never after a visible reaction; `.not` timing unchanged; replays that passed through a reflowed element now fail or warn; failed e2e flows report their own `failure.png`.

## Open questions from the clusters

1. Should a role change also count as "present, changed" for lazy replay kinds (today strict: missing)?
2. May `android-state.ts` move to non-strict parsing in a later wave so additive fields (`uiadUnsupportedAt`) become possible?
3. Should the "failed its health probe" wording change for readiness timeouts, and should reused already-booted devices get a shorter ready budget (~60 s)?
4. Should `expect.soft` and driver tracing read the attempt-bound view too (closes the remaining 08-1 leaks)?
5. Is a 30 s devtools reconnect budget acceptable for `warden ui logs` collectors?
6. After `openLink({ accept: false })`, `systemAlerts: "dismiss"` now presses Open on a remaining "Open in …?" sheet (before: Cancel). Acceptable?
7. Should alias build rows show the primary's size in `builds ls`?
8. 14-5: "spawned under the device's current lease" is the no-replace rule; should a rebuilt binary replace the helper mid-lease? Should the 5 s busy-replacement threshold be configurable?
9. 18-2: treat other bind errors on `0.0.0.0` as unsupported too?

## Device checklist

Run on a Mac with Xcode and an Android emulator before the PR leaves draft. Each line names the cluster.

- [ ] builds: fresh `git worktree add`, `warden e2e example --all` twice; the second run shows `source: installed|cache` on both platforms and `warden builds ls` shows the key plus a 0 B alias row.
- [ ] builds: Android twice without deleting the APK → `using up-to-date artifact`; iOS: a no-op XCBuild leaves the `.app` mtime unchanged and the fallback picks it with a matching bundle id.
- [ ] builds: `DerivedData/<name>-<hash>/info.plist` has `WorkspacePath`; two worktrees building at once vs `warden builds ls`.
- [ ] gc-claim: pool sim idle 21 min, then `WARDEN_DEBUG=1 warden e2e example` with gc due → `reuse`, no boot, no `simctl shutdown` from `gc --quiet`; `warden gc --idle 0s` and `warden claim ios` at once → "in use again, left running" or a boot after the shutdown.
- [ ] gc-claim: the current Xcode's boot error for a shutting-down sim contains `current state: Shutting Down`; 10 fresh emulators on a loaded host register; a wedged boot is quarantined and replaced.
- [ ] helper-cli: loaded host, `warden e2e` on a just-booted sim → one `warden-simd --udid` per sim; two `bun run`-launched runs keep the helper pid; `warden ui close` ∥ `warden ui snapshot` leaves no orphan; APFS `birthtimeMs` distinguishes a re-created socket.
- [ ] ios-client: `smoke.ts --kill-helper` with `WARDEN_SIMD_SOCKET`; forced warm failure then `warden e2e example` → `ps` shows one helper per sim.
- [ ] leases: `kill -9` a `warden run`, `warden claim` within 2 min reuses the device; `/clear` during a background `warden e2e` leaves the run alive.
- [ ] ui-guard: `warden ui snapshot` in a loop during `warden e2e example --platform android` → refusals, run unaffected; `--force` behaves as before.
- [ ] e2e-lib: `warden e2e example --platform android` with Metro launches and prints the one "ignoring WARDEN_LAUNCH_ARGS" line; a start right after boot does not persist `uiadUnsupported` after one failure (clear entries written by the old rule first).
- [ ] runner: `app.open()` ×3 then `device.devtools.evaluate("1+1")` → 2; a hanging body's late tap fails with `SESSION` and the next trace has no foreign steps; on a wedged device the `■` and results line precede the next `▶`.
- [ ] tap-flake: `bun run bench run --frameworks warden --runs 3` on both platforms; iOS snapshots per rep ≈ 170; Android: a dropped press re-sent at ~1 s, never after a reaction; erased sim, deep-link flow 20× → no `device.alert` answered inside `device.openLink`.
- [ ] small-fixes: a failing e2e flow's report `screenshot` is a `failure.png`; `touch src/lib/newfile.ts` in `apps/example` then `warden affected example --explain` lists it; `exec.test.ts` on macOS.

## Next: Wave 2

A second agent wave starts on `claude/wdn-perf-wave2` (stacked on this branch) once this branch's CI is green: the Android warden-owned quick-boot snapshot (on by default) and emulator flags, the iOS claim path (golden lock, `AutomationEnabled` in the golden, timeouts, quarantine TTL), the headless hide, per-pool batch barriers and slim at `onLeased`, `app.open({ wait: { until } })` and `am start -W`, the fingerprint memo and build-cache pruning from gc, bench CPU-seconds and per-process split, the tap hit-test, `typescript` out of the binary and lazy zod, and state-file hygiene.

## Not in this wave

Everything the report lists under Wave 2 (wall-time items needing device timing) and Wave 3 (policy: Android snapshot and emulator flags, `warden warm`, `typescript` out of the binary, wire additions, CI emulator matrix). Java and Swift halves of 04-1 and 04-6 (`connect_error` reason, owner-tagged `warden-uiad`) wait for a toolchain run.
