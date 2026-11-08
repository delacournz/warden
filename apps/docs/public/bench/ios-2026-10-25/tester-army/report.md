# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.3.1
- **Host load at start:** 2.42
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `6E375570-E6F4-4EE3-9442-5E83CD919B12`
- **App:** `nz.co.delacour.warden.example`, hash `import:c283eae41c7a`, sha256 `c283eae41c7a`, 96.4 MB
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
| tester-army | ok | e2e 0.20.0 | **132.52 s** | 132.89 s | 1.00× | 150.63 s | 18.11 s | 0 ms | 495 ms | 2.24 s | 100% | 0% | 0 proc / 1 app / 1 path | 307 LOC / 0 B |

## Per-test medians (ms)

| Test | tester-army |
| --- | --- |
| onboarding steps through to sign-in | **5964 (1.00×)** |
| invalid email and short password show field errors | **21119 (1.00×)** |
| a locked account shows the form alert | **12914 (1.00×)** |
| valid credentials land on todos | **14850 (1.00×)** |
| add, complete and filter todos | **21230 (1.00×)** |
| open a todo, mark it done, then delete it | **18121 (1.00×)** |
| deep link opens a todo by id | **18094 (1.00×)** |
| settings shows the account, toggles switches and signs out | **18075 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| tester-army | 592 | 481 ms | 3.21 s | 4.01 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**tester-army**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| getbytestid | 496 | 69.5% | 267 ms | 3.23 s | 4.01 s |
| dismiss | 52 | 22.3% | 2.26 s | 2.33 s | 2.33 s |
| (unlabelled) | 32 | 6.3% | 1.03 s | 1.05 s | 1.06 s |
| accept | 4 | 1.6% | 2.02 s | 2.03 s | 2.03 s |
| warden-example | 4 | 0.2% | 290 ms | 295 ms | 295 ms |
| getbytext | 4 | 0.1% | 65 ms | 66 ms | 66 ms |

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tester-army | host | 17.74 s | 110.24 s | 13.8% | 611.2% | 598.2 MB | 2.5 GB |
| tester-army | sim | — | 619.50 s | 84.1% | 248.1% | 11.1 GB | 11.4 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| tester-army | other | 110.24 s | 598.2 MB | 2.5 GB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### tester-army

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| xcodebuild | host | 14.70 s | 83.0% | 221.6 MB | 223.0 MB | 1 |
| node entry.js | host | 1.18 s | 6.7% | 85.2 MB | 94.4 MB | 1 |
| node e2e (exit charge) | host | 0.76 s | 4.3% | 0 B | 0 B | 0 |
| snapshot-bridge | host | 0.62 s | 3.5% | 116.4 MB | 116.6 MB | 1 |
| node e2e | host | 0.43 s | 2.4% | 104.8 MB | 134.0 MB | 1 |
| other (exit charge) | host | 0.03 s | 0.2% | 0 B | 0 B | 0 |
| simctl | host | 0.00 s | 0.0% | 20.5 MB | 20.5 MB | 1 |
| DTServiceHub | host | 0.00 s | 0.0% | 16.8 MB | 16.8 MB | 1 |
| (ps) | host | 0.00 s | 0.0% | 5.0 KB | 1.3 MB | 1 |
| (clang) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (pgrep) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (plutil) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| wardenexample | sim | 50.77 s | 41.4% | 381.6 MB | 441.3 MB | 9 |
| iOS | sim | 50.70 s | 41.4% | 10.1 GB | 10.1 GB | 112 |
| AgentDeviceRunnerUITests-Runner | sim | 16.40 s | 13.4% | 271.0 MB | 271.1 MB | 1 |
| bun cli.ts | sim | 2.46 s | 2.0% | 264.5 MB | 270.9 MB | 1 |
| CoreSimulatorBridge | sim | 0.62 s | 0.5% | 81.5 MB | 81.6 MB | 1 |
| simctl | sim | 0.61 s | 0.5% | 563.5 KB | 20.7 MB | 9 |
| launchd_sim | sim | 0.42 s | 0.3% | 37.7 MB | 37.7 MB | 1 |
| (launchctl) | sim | 0.14 s | 0.1% | 62.1 KB | 15.9 MB | 1 |
| ps | sim | 0.14 s | 0.1% | 1.8 MB | 1.8 MB | 262 |
| (managedappdistri) | sim | 0.13 s | 0.1% | 68.6 KB | 17.6 MB | 1 |
| xpcproxy_sim | sim | 0.11 s | 0.1% | 119.0 KB | 13.4 MB | 4 |
| launchctl | sim | 0.07 s | 0.1% | 10.4 KB | 2.7 MB | 1 |
| other | sim | 0.00 s | 0.0% | 87.2 MB | 87.2 MB | 3 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **tester-army:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/tester-army (4.9 MB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-tester-army`.
