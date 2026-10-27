# e2e framework benchmark — ios 2026-10-16

- **Host:** MacBook Pro (16-inch, 2023), Apple M3 Max, 14 cores, 36.0 GB RAM, macOS 26.0 (25A354)
- **Toolchain:** Xcode 26.0.1, Java 21.0.5, Node 24.19.0, bun 1.3.14, warden 0.19.0
- **Host load at start:** 1.42
- **Device:** iPhone 17 Pro (ios, iOS 26.0), udid `9F3C2E7A-5B1D-4C88-A0E4-7D2B6C1F8E55`
- **App:** `nz.co.delacour.warden.example`, hash `3fa91c07b2de`, sha256 `9b4e1c7a52d0`, 59.0 MB
- **Options:** runs 3, retries 0, reboot between no, caffeinated yes
- **Frameworks:** warden 0.19.0, argent 0.11.2, agent-device 0.7.4, tester-army 0.20.0

## Fairness rules

- Same `.app` for every framework (sha256 recorded above)
- Zero LLM calls
- Same assertions per canonical test id
- Same retry helpers (dropped first tap, dropped deep link, system alerts)
- Fresh app launch per test
- `retries=0`
- Frameworks run sequentially
- `caffeinate -dims` held for the run
- Warm medians exclude rep 1 (cold)
- Machine-readable reporters only
- Host otherwise idle; load average recorded
- Android `sim` counts the app and every framework's on-device helpers (uiautomator, instrumentation runners, agent-device, Argent, warden-uiad), matched case-insensitively
- Host processes are tracked by pid and start time, so a reused pid is never counted
- Android animation scales are reset to the device's original values before every framework and restored at the end

## Summary

| Framework | Status | Version | Suite median (warm) | p95 | Ratio | Cold rep 1 | Cold-start cost | Prepare | Teardown | Overhead | Pass rate | Flake | Residue | Footprint (LOC / deps) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warden | ok | 0.19.0 | **61.41 s** | 61.48 s | 1.00× | 80.25 s | 21.14 s | 2.30 s | 600 ms | 9.82 s | 100% | 0% | 0 proc / 0 app / 0 path | 412 LOC / 0 B |
| argent | ok | 0.11.2 | 112.67 s | 113.11 s | 1.83× | 147.26 s | 38.69 s | 4.10 s | 900 ms | 20.07 s | 100% | 0% | 0 proc / 0 app / 0 path | 298 LOC / 0 B |
| agent-device | ok | 0.7.4 | 133.78 s | 134.03 s | 2.18× | 175.62 s | 47.44 s | 5.60 s | 1.20 s | 25.17 s | 100% | 0% | 1 proc / 1 app / 1 path | 354 LOC / 30.0 MB |
| tester-army | failed | 0.20.0 | — | — | — | — | — | — | — | — | — | — | — | — |

## Per-test medians (ms)

| Test | warden | argent | agent-device | tester-army |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | **6270 (1.00×)** | 10985 (1.75×) | 12747 (2.03×) | — |
| invalid email and short password show field errors | **5132 (1.00×)** | 9148 (1.78×) | 10602 (2.07×) | — |
| a locked account shows the form alert | **4293 (1.00×)** | 7688 (1.79×) | 9101 (2.12×) | — |
| valid credentials land on todos | **6946 (1.00×)** | 12550 (1.81×) | 14818 (2.13×) | — |
| add, complete and filter todos | **8404 (1.00×)** | 15357 (1.83×) | 17491 (2.08×) | — |
| open a todo, mark it done, then delete it | **9318 (1.00×)** | 16692 (1.79×) | 19966 (2.14×) | — |
| deep link opens a todo by id | **6033 (1.00×)** | 10921 (1.81×) | 13185 (2.19×) | — |
| settings shows the account, toggles switches and signs out | **5198 (1.00×)** | 9259 (1.78×) | 10705 (2.06×) | — |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 98 | 939 ms | 1.98 s | 2.23 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**warden**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| assert | 40 | 44.5% | 1.05 s | 2.04 s | 2.23 s |
| open | 10 | 13.4% | 1.43 s | 1.98 s | 1.98 s |
| submit | 8 | 9% | 1.12 s | 2.16 s | 2.16 s |
| signed | 8 | 6.9% | 1.02 s | 1.21 s | 1.21 s |
| next | 4 | 4.5% | 1.27 s | 1.49 s | 1.49 s |
| toggle | 4 | 3.3% | 689 ms | 1.35 s | 1.35 s |
| delete | 2 | 3.1% | 1.61 s | 1.68 s | 1.68 s |
| filter | 4 | 3% | 650 ms | 1.29 s | 1.29 s |
| other | 18 | 12.4% | 660 ms | 1.52 s | 1.52 s |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 10.32 s | 20% | todo-detail/open-toggle-delete (1.86 s) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warden | host | 2.50 s | 8.00 s | 21.4% | 96.3% | 210.0 MB | 260.0 MB |
| warden | sim | — | — | 31.7% | 140.2% | 1.4 GB | 1.6 GB |
| argent | host | 2.50 s | 8.00 s | 21.4% | 96.3% | 210.0 MB | 260.0 MB |
| argent | sim | — | — | 31.7% | 140.2% | 1.4 GB | 1.6 GB |
| agent-device | host | 2.50 s | 8.00 s | 38.2% | 212.5% | 640.0 MB | 910.0 MB |
| agent-device | sim | — | — | 31.7% | 140.2% | 1.4 GB | 1.6 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| warden | bun-test | 6.00 s | 100.0 MB | 120.0 MB |
| warden | warden-simd | 2.00 s | 30.0 MB | 31.0 MB |
| argent | bun-test | 6.00 s | 100.0 MB | 120.0 MB |
| argent | warden-simd | 2.00 s | 30.0 MB | 31.0 MB |
| agent-device | bun-test | 6.00 s | 100.0 MB | 120.0 MB |
| agent-device | warden-simd | 2.00 s | 30.0 MB | 31.0 MB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### warden

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| bun test | host | 0.92 s | 46.0% | 92.0 MB | 101.0 MB | 1 |
| warden-simd | host | 0.54 s | 27.0% | 31.0 MB | 34.0 MB | 1 |
| SimulatorFrameworkBridge-iOS serve | host | 0.32 s | 16.0% | 22.0 MB | 24.0 MB | 11 |
| xcrun simctl launch | host | 0.14 s | 7.0% | 8.0 MB | 9.0 MB | 9 |
| simctl | host | 0.08 s | 4.0% | 5.0 MB | 6.0 MB | 9 |
| backboardd | sim | 2.28 s | 38.0% | 82.0 MB | 90.0 MB | 1 |
| Example | sim | 1.86 s | 31.0% | 310.0 MB | 341.0 MB | 1 |
| SpringBoard | sim | 1.08 s | 18.0% | 140.0 MB | 154.0 MB | 1 |
| launchd_sim | sim | 0.78 s | 13.0% | 41.0 MB | 45.0 MB | 1 |

### argent

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| node tool-server.cjs | host | 1.40 s | 70.0% | 140.0 MB | 154.0 MB | 1 |
| bun test | host | 0.40 s | 20.0% | 60.0 MB | 66.0 MB | 1 |
| xcrun simctl io | host | 0.20 s | 10.0% | 6.0 MB | 7.0 MB | 14 |
| backboardd | sim | 2.28 s | 38.0% | 82.0 MB | 90.0 MB | 1 |
| Example | sim | 1.86 s | 31.0% | 310.0 MB | 341.0 MB | 1 |
| SpringBoard | sim | 1.08 s | 18.0% | 140.0 MB | 154.0 MB | 1 |
| launchd_sim | sim | 0.78 s | 13.0% | 41.0 MB | 45.0 MB | 1 |

### agent-device

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| node daemon.js | host | 1.10 s | 55.0% | 310.0 MB | 341.0 MB | 1 |
| xcodebuild | host | 0.70 s | 35.0% | 280.0 MB | 308.0 MB | 1 |
| bun test | host | 0.20 s | 10.0% | 50.0 MB | 55.0 MB | 1 |
| backboardd | sim | 2.28 s | 38.0% | 82.0 MB | 90.0 MB | 1 |
| Example | sim | 1.86 s | 31.0% | 310.0 MB | 341.0 MB | 1 |
| SpringBoard | sim | 1.08 s | 18.0% | 140.0 MB | 154.0 MB | 1 |
| launchd_sim | sim | 0.78 s | 13.0% | 41.0 MB | 45.0 MB | 1 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **warden:** none
- **argent:** none
- **agent-device:** processes: agent-device daemon; driver apps: com.callstack.agentdevice.runner.xctrunner; paths: ~/.agent-device (4.0 MB)

## Unsupported / failed

- **tester-army:** failed in phase `run`. parity breach: unmapped tests: sign-in › accepts any email (not in manifest)

---

Generated by @delacour/warden-e2e-bench schema v1, run `bench-2026-10-16-ios-a1b2c3`.
