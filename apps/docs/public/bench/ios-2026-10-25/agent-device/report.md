# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.3.1
- **Host load at start:** 2.95
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `E763773F-42D2-4069-98B9-BEB57C4DF899`
- **App:** `nz.co.delacour.warden.example`, hash `import:c283eae41c7a`, sha256 `c283eae41c7a`, 96.4 MB
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
| agent-device | ok | agent-device 0.21.31 | 91.61 s ✗ | 91.70 s | — | 87.46 s | 12.23 s | 16.37 s | 315 ms | 213 ms | 97.5% | 2.5% | 0 proc / 1 app / 1 path | 158 LOC / 0 B |

## Per-test medians (ms)

| Test | agent-device |
| --- | --- |
| onboarding steps through to sign-in | **3830 (1.00×)** |
| invalid email and short password show field errors | 16579 ✗ |
| a locked account shows the form alert | **9673 (1.00×)** |
| valid credentials land on todos | **9784 (1.00×)** |
| add, complete and filter todos | **15470 (1.00×)** |
| open a todo, mark it done, then delete it | **12422 (1.00×)** |
| deep link opens a todo by id | **10483 (1.00×)** |
| settings shows the account, toggles switches and signs out | **13136 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| agent-device | 632 | 471 ms | 1.62 s | 1.89 s |

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agent-device | host | 11.18 s | 78.73 s | 13.6% | 611.5% | 711.9 MB | 2.4 GB |
| agent-device | sim | — | 433.50 s | 86.0% | 248.7% | 10.8 GB | 11.0 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| agent-device | other | 78.73 s | 711.9 MB | 2.4 GB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### agent-device

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| xcodebuild | host | 7.97 s | 71.9% | 219.6 MB | 220.4 MB | 1 |
| bun cli.ts | host | 1.93 s | 17.4% | 239.8 MB | 245.3 MB | 1 |
| snapshot-bridge | host | 0.78 s | 7.0% | 116.6 MB | 116.7 MB | 1 |
| ps | host | 0.22 s | 2.0% | 1.8 MB | 1.9 MB | 181 |
| node agent-device | host | 0.14 s | 1.3% | 61.1 MB | 66.7 MB | 1 |
| simctl | host | 0.04 s | 0.4% | 20.3 MB | 20.3 MB | 1 |
| node agent-device (exit charge) | host | 0.01 s | 0.1% | 0 B | 0 B | 0 |
| DTServiceHub | host | 0.00 s | 0.0% | 16.4 MB | 16.4 MB | 1 |
| caffeinate | host | 0.00 s | 0.0% | 7.1 MB | 7.1 MB | 1 |
| (clang) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (ps) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (simctl) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 37.64 s | 44.2% | 10.1 GB | 10.1 GB | 110 |
| wardenexample | sim | 36.00 s | 42.3% | 375.2 MB | 438.6 MB | 8 |
| AgentDeviceRunnerUITests-Runner | sim | 10.00 s | 11.7% | 269.7 MB | 269.8 MB | 1 |
| simctl | sim | 0.55 s | 0.6% | 749.3 KB | 20.7 MB | 8 |
| CoreSimulatorBridge | sim | 0.54 s | 0.6% | 81.6 MB | 81.7 MB | 1 |
| launchd_sim | sim | 0.21 s | 0.2% | 37.0 MB | 37.1 MB | 1 |
| xpcproxy_sim | sim | 0.16 s | 0.2% | 257.5 KB | 12.7 MB | 6 |
| launchctl | sim | 0.08 s | 0.1% | 24.8 KB | 4.4 MB | 1 |
| pkd | sim | 0.00 s | 0.0% | 59.1 MB | 59.1 MB | 1 |
| aslmanager | sim | 0.00 s | 0.0% | 21.2 MB | 21.2 MB | 1 |
| (launchctl) | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (managedappdistri) | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **agent-device:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/agent-device (2.9 MB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-agent-device`.
