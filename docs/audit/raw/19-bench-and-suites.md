# Audit 19: bench-and-suites

Scope: `packages/e2e-bench` harness, orchestrator, warden adapter, results/report math, `suites/warden` (and its `apps/example/e2e` copy), `warden ui bench` and its smoke. Goal: where the bench numbers the other auditors rely on can mislead, plus suite-side waste. All citations `@dfcc68b`. Nothing in this audit was timed on a device; the one thing I ran that produced a number is flagged (19-1).

## Top 5 by impact

1. 19-5: the sampler's `%cpu` comes from `ps`, which on macOS is a lifetime/decayed average, not CPU used in the last tick, so the CPU series and the K12 target cannot be read as rates.
2. 19-6: `resources` is one average over prepare + teardown + inter-rep housekeeping + runs, so "host CPU avg" moves with suite length (the K12 12.1 % vs 9.4 % result); per-rep CPU-seconds is the metric that can be compared.
3. 19-1: `realExec` does not bound a call by `timeoutMs` when a grandchild holds the pipes (a 100 ms timeout returned after 3004 ms here; `exec.test.ts` "times out" fails here); candidate for the K13 flake and a hang risk for the 15 min suite timeout.
4. 19-3: the load gate runs before `app ensure` (which can build) and compares a 1-minute load average to the core count, so a first framework (warden) can be measured right after a build.
5. 19-2: the bench claims with the 5-minute agent TTL and never heartbeats during multi-minute framework runs, so the lease can be reclaimed mid-run.

## Findings

### 19-1 `realExec` timeout is not a bound when a grandchild keeps the pipes open
- Category: robustness
- Severity: P1
- Known?: known-extended K13
- Evidence: `packages/e2e-bench/src/harness/exec.ts:115-118` on timeout kills only the direct child (`proc.kill("SIGTERM")`, then `SIGKILL` after 5 s). `exec.ts:121-125` then `await Promise.all([drain(stdout), drain(stderr), proc.exited])`; `drain` (`exec.ts:55-65`) reads until EOF, which does not come while any descendant still holds the inherited pipe. I ran `realExec.run("sh", ["-c","sleep 3"], {timeoutMs:100})` on this Linux box (sh = dash, which forks): result `{"timedOut":true,"code":143,"ms":3004}`. `bun test src/harness` fails here: `exec.test.ts:17-20` "realExec > times out" ("timed out after 5000ms": it sleeps 5 s against bun's default 5 s test timeout, `exec.test.ts:18`). The same unbounded wait applies to `SUITE_TIMEOUT_MS` (15 min) for `bun test` in `adapters/warden.ts:31,245-250` and to every 30/60 s timeout in `isolation.ts`/`residue.ts`.
- Impact: robustness. A framework whose runner leaves a child behind (adb, a JVM, `warden-simd`) turns a bounded timeout into an unbounded hang of the whole bench; on macOS `/bin/sh -c "sleep 5"` probably execs so the unit test passes there, but its margin to the 5 s test timeout is zero, so under load it is the one wall-clock test in the package (K13 candidate: `exec.test.ts` is the only test using `realExec` with time, `grep realExec src/**/*.test.ts`). Not a speed number.
- Proposed fix: spawn with `detached: true` and kill the process group (`process.kill(-pid, sig)`), and after the kill stop draining after a short grace (race `drain` against `proc.exited` + ~250 ms, then cancel the readers). Change the test to `exec sleep 5` or `sleep 30` with an assert on elapsed < 2 s. Additive (harness only).
- Effort: S
- Risk: low. Process-group kill must not hit the bench itself; verify the group is the child's.
- How to verify: `bun test packages/e2e-bench/src/harness/exec.test.ts` on Linux (red now); add a test with `sh -c "sleep 30 & wait"` and assert `durationMs < 2000`.
- Confidence: high (reproduced here); the macOS attribution of K13 is med-low.
- Verified by: ran `bun test` (src/harness) and a 5-line script.

### 19-2 The bench's lease uses the 5-minute agent TTL and is never heartbeated
- Category: robustness
- Severity: P1
- Known?: new
- Evidence: `harness/device.ts:44` runs `warden claim <platform> --json` with no `--ttl`. `apps/cli/src/commands/claim.ts:62-67` picks `BARE_CLAIM_AGENT_TTL_MS` (`packages/core/src/config.defaults.ts:4` = 5 min) when the owner is an agent session. The only `warden` calls that refresh the lease are `ui close`/`ui snapshot` (`ensureCallerLease` heartbeats own leases, `apps/cli/src/device-lease.ts:56-60`), which the orchestrator makes at isolation, warden prepare and warden teardown (`isolation.ts:54`, `adapters/warden.ts:160,169`). A framework's reps run `bun test`/maestro/etc. with no warden call: `orchestrator.ts:217-223` loops 3 reps of 1-4 minutes each (the plan budgets 2-4 min per framework rep, `docs/plans/wdn-bench.md:191`). No `heartbeat` string exists in `packages/e2e-bench/src`.
- Impact: when the bench is started by an agent session, the lease can go stale mid-framework; another agent's `warden claim` then takes the same simulator ("stale -> taken over", `device-lease.ts:60-70`) and its shutdown/erase corrupts the run (numbers, and the other agent's device). Not measurable here; the effect is a failed or silently noisy framework.
- Proposed fix: pass `--ttl 4h` (or `2 x` the planned run) in `claimDevice`, and heartbeat from the orchestrator every 60 s (`warden heartbeat <leaseId>`, `apps/cli/src/commands/heartbeat.ts`) on a timer cleared in the `finally`. For `--udid` runs, document that the caller must hold the lease. Additive (cli flag already exists).
- Effort: S
- Risk: low; a longer TTL delays reclaim only if the bench dies without `finally` (second SIGINT, 19-19).
- How to verify: orchestrator test with a fake exec asserting the claim argv contains `--ttl` and a heartbeat call is made during a long fake rep; on a device, run the bench with `WARDEN_SESSION_ID` set and `warden list` mid-run.
- Confidence: med-high (TTL path read; behaviour of owner resolution under the bench not run)
- Verified by: traced path from `claimDevice` to `BARE_CLAIM_AGENT_TTL_MS` to `ensureCallerLease`.

### 19-3 The load gate sits before the app build, compares a 1-minute average to the core count, and is never recorded again
- Category: flake-risk
- Severity: P1
- Known?: new (relates to K13)
- Evidence: `orchestrator.ts:428-433` checks `loadTooHigh` (`orchestrator.ts:88-90`: `loadAvgAtStart > cores`, `harness/host.ts:72` = `loadavg()[0]`) first; then `claimDevice` (`:434`), Android settings (`:443-448`), and `ensureApp` (`:450`) which runs `warden app ensure` and may build the app (minutes, K8 fresh-checkout path). The first framework runs immediately after. Default order puts warden first (`args.ts:40`). The 1-minute average is still high for about a minute after a build and is a decayed value, so the gate that passed at t0 says nothing about the first rep. The run records `loadAvgAtStart` only (`skeleton`, `orchestrator.ts:470-492`); the perf docs show runs at load 7.17 vs 6.14 (`docs/bench/ios-2026-10-16-perf.md:141`), and the threshold `load > cores` allows a saturated host.
- Impact: every cross-run comparison (the K12/K13 evidence, both perf docs) carries an unrecorded load confound; the first framework's cold rep is the most exposed. No number to quote; an estimated spread is in the docs' own "a few percent is inside the spread" line (`android-2026-10-16-perf.md:138`).
- Proposed fix: (a) move the check after `ensureApp` and make it a wait: poll `loadavg` until `< 0.5 x cores` for up to N minutes, then proceed or abort unless `--force`; (b) store `loadavg()[0]` at each framework start and each rep start in `RepResult`/`FrameworkResult` and print it in `report.md`; (c) have `compare` warn when the two runs' loads differ by more than 25 %. Additive to the results schema (`SCHEMA_VERSION` bump).
- Effort: S-M
- Risk: low; adds waiting time to runs on a busy machine.
- How to verify: orchestrator test with a fake `now`/loadavg injector (add an injectable `loadavg` to `BenchDeps`); bench run on a Mac right after a cold `app ensure`.
- Confidence: high on the ordering (read), med on the impact size
- Verified by: read.

### 19-4 Fixed framework order puts warden first, always
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence: `args.ts:40` default `warden,maestro,argent,agent-device,tester-army,detox`; `orchestrator.ts:496-518` runs `opts.frameworks` in that order; there is no rotation option. Run time is 1-1.5 h (`docs/plans/wdn-bench.md:191`), so thermals, sim memory growth and background load differ between position 1 and 6.
- Impact: a systematic order effect on the headline ratio (warden vs the rest); unknown size. Cheap to bound: run the same bench twice with reversed `--frameworks`.
- Proposed fix: add `--order reverse|rotate|random` (seeded, seed stored in `options`), and recommend one reversed run when publishing ratios. Additive.
- Effort: S
- Risk: low
- How to verify: two runs with `--frameworks warden,maestro` and `maestro,warden` on the same host; compare per-framework warm medians with `bench compare`.
- Confidence: med
- Verified by: read.

### 19-5 `ps %cpu` is not the CPU used in the last tick on macOS
- Category: correctness
- Severity: P1
- Known?: known-extended K12
- Evidence: `harness/sampler.ts:19` samples `ps -axo pid,ppid,rss,%cpu,lstart,command`; `sampler.ts:133-141` sums `%cpu` per tick; `sampler.ts:199-208` averages and takes the max of those sums as `cpuAvgPct`/`cpuPeakPct`. BSD/macOS `ps %cpu` is the process's decayed/lifetime utilisation (cputime over elapsed since start, or the scheduler's decaying average), not utilisation over the last 500 ms; `top -l 2` or `cputime` deltas are the instantaneous measures. I could not run macOS here. Consequence if true: a process that spiked at start (`warden-simd` after prepare, `bun test` during preload) keeps a high reading for the rest of its life, a process that has been idle long reads low when it gets busy, and "peak" is not a peak of load.
- Impact: every host CPU figure (K12: 12.1 % vs 9.4 %; Android 3.0 % vs 0.6 %) has a bias of unknown sign. Not a speed gain; it decides whether the targets in `wdn-perf.md:647` can be judged at all.
- Proposed fix: sample cumulative CPU time (`ps -o time` is 10 ms resolution on macOS; `ps -o cputime` same) and difference it per pid between ticks, charging a dead pid's last reading to the previous tick; report CPU-seconds and `cpu% = delta cputime / delta wall`. Keep `rss` as is. Schema change is additive (new `cpuSeconds` field).
- Effort: M
- Risk: med; changes every historical CPU number, so keep both for one release and re-baseline.
- How to verify: on a Mac, run a 10 s busy loop (`yes > /dev/null` for 3 s then idle 7 s) and print `ps -o %cpu,time -p $pid` once per second: if `%cpu` decays slowly after the loop stops, confirmed. Then run the sampler against it and compare to the delta-time figure.
- Confidence: med (macOS semantics from memory of BSD ps, unverified on this box)
- Verified by: read; needs a Mac.

### 19-6 `resources` averages over prepare, teardown and housekeeping, so "CPU avg" depends on suite length
- Category: perf-cpu
- Severity: P1
- Known?: known-extended K12
- Evidence: `orchestrator.ts:328-344` starts one sampler before `executeAdapter` and stops it after teardown, so the single `host`/`sim` `Series` covers `prepare` (a 708 ms cold helper start, `ios-...perf.md:26`), each rep's `terminateApp` and `dismissAnr` (`orchestrator.ts:188-195`, three adb calls on Android), the runs, and `teardown`. Per-rep ticks are written to `rep-N/resources.ndjson` (`orchestrator.ts:187`) but nothing reads them (`grep resources.ndjson` finds only the writers) and no per-rep Series is stored in `RepResult`. `series()` (`sampler.ts:199-208`) is a mean of per-tick rates. The perf doc itself explains 12.1 % vs 9.4 % by "the suite is 40 % shorter; total CPU per rep went down" (`wdn-perf.md:647`): an average of rates over a fixed overhead window falls or rises with the denominator.
- Impact: the "<= 5 % avg" target (`wdn-perf.md:381,647`) can be met by lengthening idle time. Measured: 12.1 % vs 9.4 % moved opposite to CPU-seconds (-23 %/rep), same doc line.
- Proposed fix: record, per rep, the tick window of the timed `run` only (start/end on the sampler clock), and store `RepResult.resources = {host, sim, cpuSeconds, rssPeakBytes}` computed from that window; report CPU-seconds per rep as the headline and keep the framework-wide Series as "whole-framework". Target `wdn-perf` acceptance on CPU-seconds per rep. Additive schema.
- Effort: M
- Risk: low (report-only); the new field needs a `SCHEMA_VERSION` note.
- How to verify: unit test with synthetic ticks across a rep boundary; re-run `bun run bench run --platform ios --frameworks warden --runs 3` and check the CPU-seconds equals the sum of the ndjson ticks inside the run window.
- Confidence: high
- Verified by: read; traced `startSampler` to `Series` to `bench-results.json`.

### 19-7 K2: a per-process split costs nothing extra and would attribute the 116 to 149 MB
- Category: perf-ram
- Severity: P2
- Known?: known-extended K2
- Evidence: `sampler.ts:270-284` already has every host row in memory (`rows`) and reduces them to one number with `total()` (`sampler.ts:133-141`). No extra spawn is needed to group by role. Host RSS is the sum of `ps rss` over the bench's descendants and owned pattern matches (`hostPids`, `sampler.ts:178-188`), so likely members are: the `bun test` process, `warden-simd` (resident helper, `/warden-simd/` pattern, `adapters/warden.ts:272`) and short-lived `adb`/`xcrun`. The orchestrator itself is not a root pid (`trackingExec` only records children, `orchestrator.ts:98-111`), so it is not in the number. RSS from `ps` counts shared library pages in each process (the report says so), so a sum over N processes over-counts.
- Impact: attributes the 33 MB unexplained growth (`ios-...perf.md:28`) to a process. Cost: one extra field per tick, about 5 numbers; no spawn.
- Proposed fix: classify each owned row by `basename(command argv[0])` plus a label from `trackingExec` (record `cmd`+`args[0]` with the pid) into groups (`bun-test`, `warden-simd`, `warden-cli`, `adb`, `other`) and add `Tick.hostByGroup`; sum per group in `Series`. For shared pages, take one `footprint -p <pid>` (macOS) per big process at rep end instead of per tick. Additive.
- Effort: S-M
- Risk: low
- How to verify: sampler unit test with a `ps` fixture holding bun + simd rows; on a Mac compare the two big processes against `footprint`.
- Confidence: high on cost, med on what it will show
- Verified by: read.

### 19-8 Device backend processes are in neither the host nor the sim number
- Category: test-gap
- Severity: P2
- Known?: new
- Evidence: Android `sim` = guest `top` rows filtered by `ANDROID_TARGET` (`sampler.ts:88-98`): the app, instrumentation and helper processes only; the emulator's host process (qemu / `emulator`) is not a bench descendant (started by warden) and matches no `processPatterns`, so it is in neither series. iOS `sim` = `launchd_sim` tree by udid (`simPids`, `sampler.ts:190-196`); `CoreSimulatorService`, `Simulator.app` and the render server are host-side processes without the udid in their command line. The Android doc quotes "device CPU avg 49.6 %" (`android-2026-10-16-perf.md:25`) with the host-side emulator load invisible. Frameworks stress the backend differently (screenshot-heavy vs AX), so the omitted part is not constant across frameworks.
- Impact: undercounts total machine cost; the comparison of frameworks' host cost excludes the largest consumer on Android (an emulator typically uses a few cores while the guest is busy; not measured here).
- Proposed fix: add a third series `backend` for processes matching `/qemu-system|emulator|CoreSimulatorService|Simulator\.app|SimRenderServer/` owned by udid/serial (argv contains `-avd`/the serial's port) and report it separately; do not merge into host. Additive.
- Effort: S
- Risk: low; matching `emulator` too broadly would catch other users' emulators, so reuse `ownerFilter`.
- How to verify: Mac with a running AVD: `ps -axo pid,rss,%cpu,command | grep qemu` to confirm the process and that it reflects guest load.
- Confidence: med
- Verified by: read.

### 19-9 Android residue is checked on the host only, so it can never see a guest process
- Category: test-gap
- Severity: P2
- Known?: new
- Evidence: `residue.ts:83` lists processes with host `ps` for both platforms; the warden adapter's `residuePatterns.processes` is `[/warden-simd/]` (`adapters/warden.ts:272`), and its Android `teardown` is a no-op (`adapters/warden.ts:167-168`). `wdn-perf.md:564` has the acceptance "`adb shell ps | grep uiad` empty after the run". The bench's Android "residue: 0 processes" therefore does not test that.
- Impact: a leaked `warden-uiad` (or any framework's on-device server) is invisible; it would also hold the device UiAutomation for the next framework (`isolation.ts:67-70` says exactly this about maestro and argent).
- Proposed fix: for Android, add a guest check to `checkResidue`: `adb shell ps -A` filtered by the same `ANDROID_TARGET`-style name list, per framework `residuePatterns.guestProcesses`. Additive.
- Effort: S
- Risk: low
- How to verify: emulator: run the warden android suite via the bench, then check `bench-results.json` residue and `adb -s <serial> shell ps -A | grep uiad`.
- Confidence: high that the check is missing; whether `uiad` leaks is unknown (needs device)
- Verified by: read.

### 19-10 The sampler's own load is outside the host number and ticks can bunch up
- Category: perf-cpu
- Severity: P2
- Known?: new
- Evidence: `sampler.ts:274` spawns `ps` every 500 ms through the untracked `deps.exec` (`orchestrator.ts:329`), so its CPU is not counted in `host` (not a root pid, not a descendant) but it runs during the timed rep. On a macOS box with several hundred processes a `ps` with `lstart` costs tens of ms of CPU, estimated 5-10 % of one core (2 spawns/s x 30-50 ms): unmeasured, estimated. Android adds `adb shell top -n 1 -b` every 2 s (`sampler.ts:244-247,283`) which runs inside the guest being measured and is awaited inside the tick chain (`sampler.ts:298`: `inflight.then(tick)`), so while it is slow the interval keeps queuing ticks (`setInterval` does not wait) and they run back to back afterwards, clustered in time but weighted equally in the mean (`sampler.ts:199-208` is a mean of ticks, not time-weighted).
- Impact: observer effect on the very runs being timed (not subtracted anywhere); on a loaded host the queue of ticks distorts the mean.
- Proposed fix: skip a tick when one is in flight (drop, do not queue); use `ps -axo pid,ppid,rss,%cpu,command` without `lstart` and fetch `lstart` only for newly seen roots (the stamps in `liveRoots`); on Android sample `top` every 2-4 s from a separate non-blocking loop and time-weight ticks by their `t`. Report the sampler's own CPU by measuring one `ps` with `/usr/bin/time -l` at start and printing it in `report.md`. Additive.
- Effort: S-M
- Risk: low
- How to verify: Mac, quiet: `time (for i in $(seq 20); do ps -axo pid,ppid,rss,%cpu,lstart,command >/dev/null; done)`; emulator: `adb shell top -n 1 -b` wall time and `adb shell top -b -n 5 -d 1` to compare.
- Confidence: low-med (sizes are estimates)
- Verified by: read.

### 19-11 With the default `--runs 3` the warm sample has n = 2: "p95" is the max, the median is the mean, stddev is biased
- Category: dx
- Severity: P2
- Known?: new
- Evidence: `args.ts:41,163` default 3 runs, rep 1 is cold; `stats.ts:69-75` medians use warm reps only, so n = 2. `percentile` (`stats.ts:11-16`) is nearest-rank: n=2 or 3 gives rank = n, i.e. the max. `median` of two is their mean (`stats.ts:18-23`). `stddev` is population (`stats.ts:28-33`), so for n=2 it is `|a-b|/2`, understating the sample sd by sqrt(2) and `cvPct` accordingly (`stats.ts:59`). `summary.ts` exports `p95` to the docs page (`summary.ts:102-110`), `tables.ts:54` prints `suiteP95Ms`. The perf docs say "one run of 3 reps ... a few percent is inside the spread" (`android-2026-10-16-perf.md:138`).
- Impact: published "p95" and "cv" columns suggest more than 2 samples can support; no timing impact.
- Proposed fix: label as `max` when n < 20, use sample sd (n-1), print `n` next to every dist cell, and make `--runs 5` the default for published runs (cold + 4 warm). Additive (display) / default change.
- Effort: S
- Risk: low; default runs 5 lengthens runs by about 33 %.
- How to verify: `stats.test.ts` cases for n = 2, 3; `bun test packages/e2e-bench/src/results`.
- Confidence: high
- Verified by: read.

### 19-12 `bench compare` has no regression guard and no comparability check
- Category: dx
- Severity: P2
- Known?: new (the guard is a process claim in `wdn-perf.md:633`: "must show no per-test regression > 5 %")
- Evidence: `report/compare.ts:39-70` computes deltas only; `cli.ts:105-114` `compare()` prints markdown and always returns 0. Nothing checks that the two runs share platform, device, app sha256, host, runs count or load; there is no noise threshold even though a 5 % bar sits inside the n=2 spread (19-11). `grep -n "5 \?%"` finds the guard only in the plan.
- Impact: a regression gate that is a human reading of a table; an A/B across different hosts or apps produces a confident-looking delta.
- Proposed fix: add `--max-regression 5` (percent) and `--min-n` options that return exit 1 when a per-test median regresses by more than the larger of the threshold and the pooled cv, and emit a header warning when platform/app sha/host/load differ. Additive (cli).
- Effort: S
- Risk: low
- How to verify: `compare.test.ts` fixtures (add pairs with a 6 % regression and mismatched sha).
- Confidence: high
- Verified by: read.

### 19-13 Non-finite stats are written as 0, so reports regenerated from the file show "0 ms" for tests that never ran
- Category: correctness
- Severity: P2
- Known?: new
- Evidence: `results/write.ts:9-11` replaces NaN/Infinity with 0 (`write.test.ts:41` pins it). `dist([])` returns NaN fields with `n: 0` (`stats.ts:39-48`); `overheadMs` can be NaN (`stats.ts:141`). The live path renders from the in-memory run (`orchestrator.ts:556-562`), but `bench report`/`summary`/`compare` re-read the file (`cli.ts:92-114`). Then `perTestMatrix` accepts the median because `Number.isFinite(0)` (`report/tables.ts:104`), so a test the framework never produced a duration for appears as a cell with `medianMs: 0` in `summary.json` and the docs page; `summary.ts:122-126` `round()` also maps NaN to 0.
- Impact: report differs depending on whether it was produced live or regenerated; a failed/missing test reads as the fastest.
- Proposed fix: keep NaN as `null` in the file (schema `z.number().nullable()` on Dist fields) and skip `n === 0` dists in `perTestMatrix`/`summary`. Contract: results schema (additive `SCHEMA_VERSION` bump).
- Effort: S
- Risk: low; old files still parse.
- How to verify: test: build a run with a missing test, write it, read it back, assert the matrix has no cell for it.
- Confidence: high
- Verified by: read (traced `writeBenchResults` to `readBenchResults` to `perTestMatrix`).

### 19-14 K11: `prepareMs` includes a `bun cli.ts` process start, so the 300 ms target is out of reach by helper work alone
- Category: perf-latency
- Severity: P2
- Known?: known-extended K11
- Evidence: `adapters/warden.ts:160` spawns `bun apps/cli/src/cli.ts ui snapshot --udid ... --json` (source, not the compiled binary) and `prepareMs` is that call's wall (`orchestrator.ts:168`). The doc's own numbers: cold 544-726 ms, warm 182-185 ms (`ios-2026-10-16-perf.md:26`). The warm figure contains the CLI start plus one snapshot, so the fixed `bun`+module-load cost is at most about 140 ms (arithmetic: 182 ms minus a ~40 ms snapshot, estimate), i.e. roughly 20-25 % of the 708 ms. Isolation then guarantees the cold path (`isolation.ts:52-64,251-255`). Teardown's `ui close` (`warden.ts:169`) carries the same start cost.
- Impact: of 708 ms, about 570 ms is the helper start (estimated); the <=300 ms target would need that to halve. The bench's `coldStartMs` (`stats.ts:142-144`) adds `prepareMs`, so the CLI start is charged to warden only (other adapters' prepare are different processes).
- Proposed fix: report a split (`prepareMs` and `prepareCliMs`, taken from a `warden version`-like no-op timed once per bench) or use the in-process timing line `ui snapshot --json` already prints if any; do not change the isolation policy. Additive.
- Effort: S
- Risk: low
- How to verify: Mac: `time bun apps/cli/src/cli.ts version` x 5 vs `warden ui snapshot` cold/warm.
- Confidence: med (estimate)
- Verified by: read.

### 19-15 Android `snapshotWarm` target (800 ms) predates `warden-uiad` and would not catch a regression to hundreds of ms
- Category: test-gap
- Severity: P2
- Known?: new (relates to K6)
- Evidence: `apps/cli/src/agent-ui/bench.ts:55-58` `android: { snapshotWarm: {p50Ms: 800}, pressHid: {p50Ms: 120} }`, tolerance 1.5 (`bench.ts:40,102-105`) = fail only above 1200 ms. The 800 target was set against the `uiautomator dump` route (`wdn-e2e.md:316` measured p50 2372 under load). The uiad plan's acceptance is p50 <= 150 ms and expects about 30 ms (`wdn-perf.md:564`), and K6 notes p95 ~270 ms right after navigation. `smoke/ui-bench.ts` exits 1 only above the tolerance (`ui-bench.ts:102-106,137-141`).
- Impact: a fallback to the dump route (3.5-8 s) is caught, but a 5-10x slowdown of the resident server is not.
- Proposed fix: set Android `snapshotWarm` to `{p50Ms: 100, p95Ms: 300}` after one quiet-host run; keep the old numbers only as the fallback-route guard. Behaviour change in a smoke threshold (policy_change false for users).
- Effort: S
- Risk: low; may fail on loaded hosts (K6), so run on a quiet one.
- How to verify: `bun run smoke:ui-bench -- --platform android --udid <serial> --runs 20` on an idle emulator; check `bench.test.ts` expectations.
- Confidence: med
- Verified by: read.

### 19-16 Suite waits: `tap({until})` re-sends are 4 s windows; the cost of a dropped press is the window, not the drop
- Category: perf-latency
- Severity: P2
- Known?: known-extended K15 (adjacent)
- Evidence: `suites/warden/helpers/flows.ts:65-79` `nextStep` uses `tap({until})` with defaults 4000 ms window, 250 ms check, 2 re-sends (`e2e/src/screen/locator.ts:718-720`). `nextStep` runs 2x in onboarding and 2x inside each of the 7 `openSignIn` calls (sign-in x3, todos, todo-detail x2, settings via `signedIn`) = 16 per rep, plus 7 `getStarted` taps (plain). A dropped first press (the documented reason, `flows.ts:57-63`) is detected only after the title has been unchanged for the whole window. `openDeepLink` (`flows.ts:81-100`) waits 6 s per attempt, 3 attempts. These are structural retries for app behaviour, parity-required, but the window length is headroom. Estimated: at a 5 % drop rate, 16 presses give 0.8 drops per rep, each costing at most 4 s minus the normal transition, i.e. up to ~3 s per rep (iOS median rep about 17-30 s, `ios-...perf.md`), and it appears as variance in warm medians, not as a constant. The real rate is unmeasured: count `locator.tap` spans per press in `trace.jsonl`.
- Impact: estimated 0-3 s/rep (0-10 %), iOS and Android, low confidence.
- Proposed fix: first measure re-send rate from existing traces; if it is under 2 %, use `windowMs: 1500` for `nextStep` (a normal step transition is a few hundred ms; the check is one snapshot per 250 ms). Suite change must be mirrored in `apps/example/e2e/helpers/flows.ts` and, for parity, the other frameworks' retry helpers (`AGENTS.md` parity rule). Additive; changes the published suite.
- Effort: S (measure) + S
- Risk: med: a shorter window can add duplicate presses on a slow transition; needs both platforms.
- How to verify: `bun run bench run --platform ios --frameworks warden --runs 3` before/after; trace spans with `op: driver.tap` per `welcome-next`.
- Confidence: low
- Verified by: read; the two copies are byte-identical (only `devtools.e2e.ts` and `helpers/poll.ts` exist in `apps/example/e2e`).

### 19-17 The rep's `wallMs` includes the adapter's post-processing and discards the adapter's own wall
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `adapters/warden.ts:244-252` measures the `bun test` wall precisely (`wallMs`), then `run` goes on to write `bun-test.log`, read `results.jsonl`, read and zod-validate each test's `trace.jsonl` (hundreds of lines), and load the manifest (`warden.ts:255-260`, `parse/warden-results.ts:363-380`). The orchestrator overwrites the result's `wallMs` with `timed("run")` around the whole `adapter.run` (`orchestrator.ts:197,208`). Parsing cost is estimated at tens of ms per rep (unmeasured); only warden pays for a trace parse of this size, and `overheadMs` (`stats.ts:130`) absorbs it.
- Impact: estimated 20-100 ms/rep (< 0.5 % of an iOS rep); fairness note only.
- Proposed fix: keep the adapter's `wallMs` (`RepResult.wallMs` from `toRep`) and let the orchestrator override only when the adapter did not set it, or make `wallSource` `"adapter"`. The schema already has `wallSource` (`schema.ts:68` literal `"harness"`, widen it). Additive.
- Effort: S
- Risk: low; changes every other adapter's wall unless gated per adapter.
- How to verify: log both numbers for a fake run; compare on a device.
- Confidence: med
- Verified by: read.

### 19-18 `warden ui bench` taps the screen centre of whatever is in front, so `pressSettle` depends on app state
- Category: flake-risk
- Severity: P3
- Known?: new
- Evidence: `agent-ui/bench.ts:225,281-296` taps `centre(width,height)` 20 times for `pressHid` and 5 times then settles for `pressSettle`; the smoke only runs `ui open <bundle>` first (`scripts/smoke/ui-bench.ts:129`) so the screen is whatever the app was last on. A centre tap can advance onboarding, focus a field (keyboard animation settle), or hit nothing (immediate settle). `snapshotWarm` p50 missed at 64-106 ms on a loaded host (`wdn-e2e.md:335`), and `helperColdToSnapshot` is capped at 3 samples (`bench.ts:65-69`) so its p95 is the max.
- Impact: run-to-run variation in `pressSettle` unrelated to the tool.
- Proposed fix: have the smoke terminate and relaunch the app (or open a deep link to a static screen) before `ui bench`, and let `ui bench` take an optional `--point x,y`. Additive (cli flag).
- Effort: S
- Risk: low
- How to verify: two smoke runs from different app states; compare `pressSettle`.
- Confidence: med
- Verified by: read.

### 19-19 A second SIGINT skips the `finally`, leaving the lease and Android device settings behind
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: `cli.ts:128-136` exits with 130 on the second signal, bypassing `runBench`'s `finally` (`orchestrator.ts:566-582`) that kills `caffeinate`, clears `hide_error_dialogs`, restores animation scales and releases exactly the claimed lease id. The first signal path is covered (`orchestrator.test.ts:347`). Also `hideErrorDialogs(..., false)` writes `0` instead of the device's original value (`anr.ts:48-61`, `orchestrator.ts:569`), unlike the animation scales which are restored from a recorded baseline.
- Impact: a leaked lease (released only by TTL, see 19-2) and a device with `hide_error_dialogs` changed after an impatient Ctrl-C.
- Proposed fix: on the second signal run a synchronous best-effort cleanup (`Bun.spawnSync` of `warden release <leaseId>` and the two `settings put`) with a 10 s cap, then exit; record and restore the original `hide_error_dialogs`. Additive.
- Effort: S
- Risk: low
- How to verify: orchestrator test with a fake signal source; on a device, Ctrl-C twice and check `warden list`.
- Confidence: high
- Verified by: read.

### 19-20 With `--retries N` the warden numbers hide the failed attempts
- Category: flake-risk
- Severity: P3
- Known?: new
- Evidence: `adapters/warden.ts:75` forwards `--retry N` to `bun test`; the runner appends to `results.jsonl` only for a passing or final attempt (`packages/e2e/src/runner/attempt.ts:32`), so a test that failed once and then passed records a single `passed` result with the passing attempt's duration. `flakeRate` (`stats.ts:90-96`) counts only differing final statuses across reps. Default is `retries=0` (fairness rule in the perf docs), so published numbers are unaffected.
- Impact: only runs with `--retries > 0` under-report time and flake.
- Proposed fix: have the warden adapter read the attempt count from `trace.jsonl` or the attempt dirs and record `attempts` in `TestResult`; or reject `--retries > 0` for warden unless `--allow-retries`. Additive.
- Effort: S
- Risk: low
- How to verify: fixture with two attempt dirs for one test; assert `attempts: 2`.
- Confidence: low-med (attempt dir layout not read in detail)
- Verified by: read.

## Known items

- K1: not re-measured here. `untracedMsOf` (`parse/warden-results.ts:315-335`) is correct for what it claims: step-end intervals are `[ts-ms, ts]`, spans `[ts, ts+ms]` (matches `trace.ts:21-22`, `step.ts:45`), clipped to the test window, sorted by start so spans written out of `ts` order are handled, nested counted once. What stays untraced: poll sleeps between spans, runner hooks, and any span written after the attempt flush (`trace.ts` "Spans written after it are lost"). A timed-out test counts its whole unended step as untraced (a 120 s outlier in `untracedRows` since there is no status filter, `tables.ts:136-156`). Status: known-stale as the doc says (0.27 s / 0.11 s on the idiomatic suite).
- K2: see 19-7 (known-extended).
- K6: only touched via 19-15 (Android target); `warden-uiad` API 37 only is unchanged.
- K11: see 19-14 (known-extended).
- K12: see 19-5, 19-6 (known-extended).
- K13: see 19-1; best candidate is `exec.test.ts` "times out"; no other bench test uses wall time (`grep` for `realExec`/`Date.now`/`performance.now` in `*.test.ts`).
- K15: only adjacent (19-16).
- K17: not touched (no `warden ui` spawn inside a timed window: the only CLI spawns near timing are warden `prepare`/`teardown`, which are timed phases by design, and isolation/claim/ensure, which are outside `timed("run")`).

## Gaps I could not assess here

- macOS `ps %cpu` semantics (19-5): `yes >/dev/null & p=$!; sleep 3; kill $p` with `ps -o %cpu,time -p $pid` once a second; and then the same for a long-lived idle process that becomes busy.
- Sampler cost (19-10): `time` 20 runs of the exact `ps` argv on the benchmarking Mac; `adb shell top -n 1 -b` wall and guest CPU on the AVD.
- Backend process load (19-8): `ps -axo pid,rss,%cpu,command | grep -E "qemu|emulator|CoreSimulator|Simulator"` during a warden rep.
- Re-send rate for `nextStep` (19-16): count `driver.tap` spans per `welcome-next` in a real `rep-N/warden-out/**/trace.jsonl`.
- Order effect (19-4): two runs with reversed framework order on the same host.
- Whether `warden-uiad` is gone after a bench rep (19-9): `adb shell ps -A | grep uiad` after `bun run bench run --platform android --frameworks warden --runs 1`.
- `bun test` with `sh` = bash on macOS for the K13 attribution (19-1).

## Owned files not read

- `packages/e2e-bench/src/results/schema.ts` (read only the stats and wall fields), `footprint.ts` (skimmed), `report/format.ts`, `manifest.test.ts`, `schema.test.ts`, `anr.test.ts`, `host.test.ts`, `phases.test.ts`, `app.test.ts`, `device.test.ts`, `isolation.test.ts`, `residue.test.ts`, `sampler.test.ts`, `orchestrator.test.ts` (ran them: 175 pass, 1 fail = 19-1; not read line by line), `args.test.ts`, `src/adapters/adapter.types.ts`, `registry.ts`, `warden.test.ts`, `fixtures/warden/**` (names only), `harness/fixtures/**`, `apps/cli/src/agent-ui/bench.test.ts` (ran, 15 pass), `scripts/smoke/ui-bench.test.ts` (ran, 5 pass), `suites/warden/helpers/flows.test.ts` (ran, passes).

## Questions for the user

1. Is the bench normally started from an agent session (owner kind `agent`) or from a user shell? If always a user shell, 19-2 drops to P3 (user leases use the 30 min TTL and are tied to the shell).
2. Is macOS `/bin/sh -c "sleep 5"` the platform where K13 happened? If the K13 failure was on a different test, 19-1 stays a Linux/robustness finding but is not the flake.

## Files read

`docs/audit/BRIEF.md`, `docs/audit/ASSIGN-19.md`, `packages/e2e-bench/src/{cli,orchestrator,args}.ts`, `src/adapters/warden.ts`, `src/adapters/parse/warden-results.ts`, `src/adapters/parse/warden-results.test.ts` (head), `src/harness/{sampler,isolation,residue,exec,device,app,anr,host,phases}.ts`, `src/results/{stats,write,manifest}.ts`, `src/results/schema.ts` (parts), `src/report/{summary,tables,compare}.ts`, `src/harness/exec.test.ts`, `suites/warden/**` (all flows, `helpers/flows.ts`, `helpers/ids.ts`), `apps/cli/src/agent-ui/bench.ts`, `scripts/smoke/ui-bench.ts`, plus for call paths: `packages/e2e/src/runner/{trace,attempt,step}.ts`, `packages/e2e/src/screen/locator.ts` (tap constants), `apps/cli/src/commands/claim.ts`, `apps/cli/src/claim-flags.ts`, `apps/cli/src/device-lease.ts`, `packages/core/src/config.defaults.ts`, `docs/bench/*-2026-10-16-perf.md` ("Read with care"), `docs/plans/wdn-bench.md` § Risks, `docs/plans/wdn-perf.md`, `docs/plans/wdn-e2e.md` (bench lines).
