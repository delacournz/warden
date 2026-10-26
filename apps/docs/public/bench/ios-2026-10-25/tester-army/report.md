# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 3.93
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `3C5306E2-29B8-4814-A251-945E2183431E`
- **App:** `nz.co.delacour.warden.example`, hash `import:2d35643eda49`, sha256 `2d35643eda49`, 96.4 MB
- **Options:** runs 5, retries 0, reboot between no, caffeinated yes
- **Frameworks:** tester-army e2e 0.20.0

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
| tester-army | ok | e2e 0.20.0 | **132.34 s** | 133.43 s | 1.00× | 151.03 s | 18.69 s | 0 ms | 523 ms | 2.21 s | 100% | 0% | 0 proc / 1 app / 1 path | 307 LOC / 0 B |

## Per-test medians (ms)

| Test | tester-army |
| --- | --- |
| onboarding steps through to sign-in | **6032 (1.00×)** |
| invalid email and short password show field errors | **20867 (1.00×)** |
| a locked account shows the form alert | **12799 (1.00×)** |
| valid credentials land on todos | **14889 (1.00×)** |
| add, complete and filter todos | **21196 (1.00×)** |
| open a todo, mark it done, then delete it | **18171 (1.00×)** |
| deep link opens a todo by id | **18056 (1.00×)** |
| settings shows the account, toggles switches and signs out | **18070 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| tester-army | 592 | 494 ms | 3.18 s | 3.98 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**tester-army**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| getbytestid | 496 | 69.2% | 273 ms | 3.19 s | 3.98 s |
| dismiss | 52 | 22.5% | 2.26 s | 2.31 s | 2.31 s |
| (unlabelled) | 32 | 6.3% | 1.02 s | 1.08 s | 1.16 s |
| accept | 4 | 1.7% | 2.03 s | 2.30 s | 2.30 s |
| warden-example | 4 | 0.2% | 290 ms | 297 ms | 297 ms |
| getbytext | 4 | 0.1% | 70 ms | 76 ms | 76 ms |

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tester-army | host | 17.01 s | 107.19 s | 13.9% | 508.1% | 599.5 MB | 2.0 GB |
| tester-army | sim | — | 914.59 s | 118.9% | 560.4% | 36.8 GB | 37.0 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| tester-army | other | 107.19 s | 599.5 MB | 2.0 GB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### tester-army

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| xcodebuild | host | 14.26 s | 84.0% | 217.0 MB | 218.2 MB | 1 |
| node entry.js | host | 1.05 s | 6.2% | 84.9 MB | 92.8 MB | 1 |
| snapshot-bridge | host | 0.63 s | 3.7% | 116.2 MB | 116.3 MB | 1 |
| (node) (exit charge) | host | 0.62 s | 3.7% | 0 B | 0 B | 0 |
| node e2e | host | 0.35 s | 2.1% | 109.4 MB | 132.3 MB | 1 |
| (node) | host | 0.03 s | 0.2% | 0 B | 0 B | 0 |
| other (exit charge) | host | 0.03 s | 0.2% | 0 B | 0 B | 0 |
| (ps) | host | 0.01 s | 0.1% | 27.9 KB | 1.7 MB | 5 |
| simctl | host | 0.00 s | 0.0% | 20.5 MB | 20.5 MB | 1 |
| DTServiceHub | host | 0.00 s | 0.0% | 16.8 MB | 16.8 MB | 1 |
| (pgrep) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (simctl) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 107.48 s | 60.4% | 35.1 GB | 35.2 GB | 289 |
| wardenexample | sim | 49.85 s | 28.0% | 380.4 MB | 441.8 MB | 9 |
| AgentDeviceRunnerUITests-Runner | sim | 15.86 s | 8.9% | 271.0 MB | 271.2 MB | 1 |
| bun cli.ts | sim | 2.56 s | 1.4% | 254.0 MB | 264.4 MB | 1 |
| CoreSimulatorBridge | sim | 0.57 s | 0.3% | 80.6 MB | 80.6 MB | 1 |
| simctl | sim | 0.54 s | 0.3% | 534.1 KB | 20.8 MB | 8 |
| launchd_sim | sim | 0.46 s | 0.3% | 51.8 MB | 51.8 MB | 1 |
| mlhostd | sim | 0.24 s | 0.1% | 135.3 KB | 14.3 MB | 3 |
| triald | sim | 0.16 s | 0.1% | 96.6 MB | 96.7 MB | 1 |
| storekitd | sim | 0.15 s | 0.1% | 128.2 MB | 128.2 MB | 1 |
| launchctl | sim | 0.10 s | 0.1% | 36.7 KB | 9.4 MB | 1 |
| ps | sim | 0.06 s | 0.0% | 1.9 MB | 1.9 MB | 263 |
| other | sim | 0.07 s | 0.0% | 446.4 MB | 870.8 MB | 8 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **tester-army:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/tester-army (4.9 MB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-tester-army`.
