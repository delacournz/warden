# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 3.85
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `07FBA7CD-07EC-40FA-8ADF-5EC275C0C571`
- **App:** `nz.co.delacour.warden.example`, hash `import:2d35643eda49`, sha256 `2d35643eda49`, 96.4 MB
- **Options:** runs 5, retries 0, reboot between no, caffeinated yes
- **Frameworks:** warden bun 1.3.14 + warden-e2e

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
| warden | ok | bun 1.3.14 + warden-e2e | **97.04 s** | 98.63 s | 1.00× | 98.33 s | 1.94 s | 652 ms | 85 ms | 80 ms | 100% | 0% | 0 proc / 0 app / 0 path | 379 LOC / 0 B |

## Per-test medians (ms)

| Test | warden |
| --- | --- |
| onboarding steps through to sign-in | **3136 (1.00×)** |
| invalid email and short password show field errors | **17987 (1.00×)** |
| a locked account shows the form alert | **11046 (1.00×)** |
| valid credentials land on todos | **10937 (1.00×)** |
| add, complete and filter todos | **16997 (1.00×)** |
| open a todo, mark it done, then delete it | **12015 (1.00×)** |
| deep link opens a todo by id | **11791 (1.00×)** |
| settings shows the account, toggles switches and signs out | **13018 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 504 | 170 ms | 3.93 s | 5.00 s |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 3.35 s | 3.5% | settings/account-switches-sign-out (718 ms) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warden | host | 9.12 s | 46.25 s | 8.1% | 59.4% | 147.8 MB | 184.9 MB |
| warden | sim | — | 563.94 s | 102.7% | 292.5% | 36.4 GB | 36.5 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| warden | bun-test | 10.27 s | 92.0 MB | 129.3 MB |
| warden | warden-simd | 35.39 s | 55.7 MB | 56.2 MB |
| warden | warden-cli | 0.13 s | 82.2 KB | 77.7 MB |
| warden | other | 0.47 s | 21.7 KB | 20.5 MB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### warden

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| warden-simd | host | 7.03 s | 77.2% | 55.9 MB | 56.0 MB | 1 |
| bun test | host | 1.15 s | 12.6% | 92.2 MB | 107.1 MB | 1 |
| bun test (exit charge) | host | 0.69 s | 7.5% | 0 B | 0 B | 0 |
| simctl | host | 0.24 s | 2.7% | 277.4 KB | 20.7 MB | 3 |
| (PlistBuddy) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (bash) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| (simctl) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| bun cli.ts | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 75.30 s | 64.7% | 34.8 GB | 34.8 GB | 286 |
| wardenexample | sim | 30.57 s | 26.3% | 374.9 MB | 432.8 MB | 8 |
| SimulatorFrameworkBridge-iOS serve | sim | 6.04 s | 5.2% | 197.7 MB | 210.2 MB | 12 |
| bun cli.ts | sim | 2.01 s | 1.7% | 235.0 MB | 241.7 MB | 1 |
| CoreSimulatorBridge | sim | 0.94 s | 0.8% | 83.7 MB | 83.9 MB | 1 |
| launchd_sim | sim | 0.39 s | 0.3% | 52.2 MB | 52.2 MB | 1 |
| xpcproxy_sim | sim | 0.26 s | 0.2% | 390.5 KB | 11.4 MB | 8 |
| mlhostd | sim | 0.24 s | 0.2% | 129.7 KB | 14.4 MB | 2 |
| ps | sim | 0.15 s | 0.1% | 1.9 MB | 1.9 MB | 191 |
| (launchctl) | sim | 0.14 s | 0.1% | 93.2 KB | 17.4 MB | 1 |
| storekitd | sim | 0.14 s | 0.1% | 127.9 MB | 127.9 MB | 1 |
| triald | sim | 0.13 s | 0.1% | 96.6 MB | 96.6 MB | 1 |
| other | sim | 0.00 s | 0.0% | 443.9 MB | 443.9 MB | 6 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **warden:** none

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-warden`.
