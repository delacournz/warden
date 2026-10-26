# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 3.51
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `F7838A8B-4109-4937-804E-B7DD9CCE79E2`
- **App:** `nz.co.delacour.warden.example`, hash `import:2d35643eda49`, sha256 `2d35643eda49`, 96.4 MB
- **Options:** runs 5, retries 0, reboot between no, caffeinated yes
- **Frameworks:** agent-device agent-device 0.21.31

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
| agent-device | ok | agent-device 0.21.31 | **91.77 s** | 91.93 s | 1.00× | 92.86 s | 18.41 s | 17.32 s | 322 ms | 223 ms | 100% | 0% | 0 proc / 1 app / 1 path | 158 LOC / 0 B |

## Per-test medians (ms)

| Test | agent-device |
| --- | --- |
| onboarding steps through to sign-in | **3867 (1.00×)** |
| invalid email and short password show field errors | **16549 (1.00×)** |
| a locked account shows the form alert | **9671 (1.00×)** |
| valid credentials land on todos | **9771 (1.00×)** |
| add, complete and filter todos | **15503 (1.00×)** |
| open a todo, mark it done, then delete it | **12491 (1.00×)** |
| deep link opens a todo by id | **10417 (1.00×)** |
| settings shows the account, toggles switches and signs out | **13228 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| agent-device | 632 | 479 ms | 1.62 s | 1.90 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**agent-device**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| press | 244 | 40.6% | 531 ms | 1.02 s | 1.07 s |
| type | 64 | 23.8% | 1.25 s | 1.87 s | 1.90 s |
| wait | 276 | 20.8% | 54 ms | 961 ms | 1.07 s |
| open | 36 | 9.3% | 1.06 s | 1.10 s | 1.12 s |
| fill | 12 | 5.5% | 1.70 s | 1.73 s | 1.73 s |

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agent-device | host | 10.30 s | 73.33 s | 12.9% | 532.8% | 745.9 MB | 2.4 GB |
| agent-device | sim | — | 683.96 s | 125.8% | 380.0% | 36.8 GB | 37.0 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| agent-device | other | 73.33 s | 745.9 MB | 2.4 GB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### agent-device

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| xcodebuild | host | 7.50 s | 73.3% | 218.0 MB | 218.7 MB | 1 |
| bun cli.ts | host | 1.77 s | 17.3% | 268.7 MB | 273.3 MB | 1 |
| snapshot-bridge | host | 0.77 s | 7.5% | 116.3 MB | 116.4 MB | 1 |
| node agent-device | host | 0.15 s | 1.5% | 61.0 MB | 66.8 MB | 1 |
| ps | host | 0.02 s | 0.2% | 1.9 MB | 1.9 MB | 182 |
| simctl | host | 0.02 s | 0.2% | 20.4 MB | 20.4 MB | 1 |
| node agent-device (exit charge) | host | 0.01 s | 0.1% | 0 B | 0 B | 0 |
| (simctl) | host | 0.00 s | 0.0% | 96.9 KB | 17.2 MB | 1 |
| DTServiceHub | host | 0.00 s | 0.0% | 16.7 MB | 16.7 MB | 1 |
| caffeinate | host | 0.00 s | 0.0% | 7.3 MB | 7.3 MB | 1 |
| (bash) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (clang) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 89.31 s | 65.7% | 35.5 GB | 35.5 GB | 291 |
| wardenexample | sim | 35.81 s | 26.3% | 371.9 MB | 438.3 MB | 8 |
| AgentDeviceRunnerUITests-Runner | sim | 9.14 s | 6.7% | 268.2 MB | 268.2 MB | 1 |
| CoreSimulatorBridge | sim | 0.51 s | 0.4% | 80.6 MB | 80.7 MB | 1 |
| simctl | sim | 0.48 s | 0.4% | 676.7 KB | 20.5 MB | 7 |
| launchd_sim | sim | 0.31 s | 0.2% | 52.4 MB | 52.4 MB | 1 |
| triald | sim | 0.13 s | 0.1% | 96.7 MB | 96.7 MB | 1 |
| storekitd | sim | 0.13 s | 0.1% | 128.3 MB | 128.3 MB | 1 |
| xpcproxy_sim | sim | 0.09 s | 0.1% | 176.0 KB | 9.1 MB | 4 |
| mlhostd | sim | 0.08 s | 0.1% | 34.2 KB | 6.1 MB | 1 |
| (wardenexample) | sim | 0.00 s | 0.0% | 2.4 MB | 433.2 MB | 1 |
| assetsd | sim | 0.00 s | 0.0% | 163.2 MB | 163.2 MB | 1 |
| other | sim | 0.00 s | 0.0% | 274.3 MB | 274.3 MB | 4 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **agent-device:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/agent-device (2.9 MB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-agent-device`.
