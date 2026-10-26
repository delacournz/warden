# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 3.85
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `07FBA7CD-07EC-40FA-8ADF-5EC275C0C571`
- **App:** `nz.co.delacour.warden.example`, hash `import:2d35643eda49`, sha256 `2d35643eda49`, 96.4 MB
- **Options:** runs 5, retries 0, reboot between no, caffeinated yes
- **Frameworks:** warden bun 1.3.14 + warden-e2e, argent 0.30.1, agent-device agent-device 0.21.31, tester-army e2e 0.20.0

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
| warden | ok | bun 1.3.14 + warden-e2e | 97.04 s | 98.63 s | 1.06× | 98.33 s | 1.94 s | 652 ms | 85 ms | 80 ms | 100% | 0% | 0 proc / 0 app / 0 path | 379 LOC / 0 B |
| argent | ok | 0.30.1 | 131.81 s | 132.14 s | 1.44× | 132.43 s | 2.35 s | 1.73 s | 511 ms | 168 ms | 100% | 0% | 0 proc / 0 app / 1 path | 161 LOC / 0 B |
| agent-device | ok | agent-device 0.21.31 | **91.77 s** | 91.93 s | 1.00× | 92.86 s | 18.41 s | 17.32 s | 322 ms | 223 ms | 100% | 0% | 0 proc / 1 app / 1 path | 158 LOC / 0 B |
| tester-army | ok | e2e 0.20.0 | 132.34 s | 133.43 s | 1.44× | 151.03 s | 18.69 s | 0 ms | 523 ms | 2.21 s | 100% | 0% | 0 proc / 1 app / 1 path | 307 LOC / 0 B |

## Per-test medians (ms)

| Test | warden | argent | agent-device | tester-army |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | **3136 (1.00×)** | 8220 (2.62×) | 3867 (1.23×) | 6032 (1.92×) |
| invalid email and short password show field errors | 17987 (1.09×) | 17962 (1.09×) | **16549 (1.00×)** | 20867 (1.26×) |
| a locked account shows the form alert | 11046 (1.14×) | 14040 (1.45×) | **9671 (1.00×)** | 12799 (1.32×) |
| valid credentials land on todos | 10937 (1.12×) | 14982 (1.53×) | **9771 (1.00×)** | 14889 (1.52×) |
| add, complete and filter todos | 16997 (1.10×) | 20867 (1.35×) | **15503 (1.00×)** | 21196 (1.37×) |
| open a todo, mark it done, then delete it | **12015 (1.00×)** | 18881 (1.57×) | 12491 (1.04×) | 18171 (1.51×) |
| deep link opens a todo by id | 11791 (1.13×) | 17367 (1.67×) | **10417 (1.00×)** | 18056 (1.73×) |
| settings shows the account, toggles switches and signs out | **13018 (1.00×)** | 19116 (1.47×) | 13228 (1.02×) | 18070 (1.39×) |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 504 | 170 ms | 3.93 s | 5.00 s |
| argent | 1192 | 318 ms | 1.82 s | 2.82 s |
| agent-device | 632 | 479 ms | 1.62 s | 1.90 s |
| tester-army | 592 | 494 ms | 3.18 s | 3.98 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**warden**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| fill | 68 | 76.5% | 3.69 s | 4.62 s | 5.00 s |
| tap | 180 | 12.2% | 154 ms | 378 ms | 605 ms |
| expect | 256 | 11.4% | 33 ms | 629 ms | 655 ms |

**argent**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| into | 68 | 28.2% | 2.12 s | 2.78 s | 2.82 s |
| idle | 232 | 26.6% | 890 ms | 1.00 s | 1.16 s |
| visible | 320 | 18.7% | 16 ms | 1.02 s | 1.03 s |
| id= | 380 | 12.7% | 318 ms | 343 ms | 354 ms |
| launch | 32 | 11.2% | 1.82 s | 1.86 s | 1.91 s |
| hidden | 32 | 2.5% | 15 ms | 1.03 s | 1.04 s |
| open-url | 4 | 0.1% | 113 ms | 116 ms | 116 ms |
| next-test.yaml | 28 | 0% | 2 ms | 5 ms | 5 ms |
| other | 96 | 0% | 1 ms | 2 ms | 6 ms |

**agent-device**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| press | 244 | 40.6% | 531 ms | 1.02 s | 1.07 s |
| type | 64 | 23.8% | 1.25 s | 1.87 s | 1.90 s |
| wait | 276 | 20.8% | 54 ms | 961 ms | 1.07 s |
| open | 36 | 9.3% | 1.06 s | 1.10 s | 1.12 s |
| fill | 12 | 5.5% | 1.70 s | 1.73 s | 1.73 s |

**tester-army**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| getbytestid | 496 | 69.2% | 273 ms | 3.19 s | 3.98 s |
| dismiss | 52 | 22.5% | 2.26 s | 2.31 s | 2.31 s |
| (unlabelled) | 32 | 6.3% | 1.02 s | 1.08 s | 1.16 s |
| accept | 4 | 1.7% | 2.03 s | 2.30 s | 2.30 s |
| warden-example | 4 | 0.2% | 290 ms | 297 ms | 297 ms |
| getbytext | 4 | 0.1% | 70 ms | 76 ms | 76 ms |

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
| argent | host | 2.79 s | 14.69 s | 1.7% | 39.7% | 182.0 MB | 261.8 MB |
| argent | sim | — | 956.48 s | 131.3% | 788.2% | 36.3 GB | 36.5 GB |
| agent-device | host | 10.30 s | 73.33 s | 12.9% | 532.8% | 745.9 MB | 2.4 GB |
| agent-device | sim | — | 683.96 s | 125.8% | 380.0% | 36.8 GB | 37.0 GB |
| tester-army | host | 17.01 s | 107.19 s | 13.9% | 508.1% | 599.5 MB | 2.0 GB |
| tester-army | sim | — | 914.59 s | 118.9% | 560.4% | 36.8 GB | 37.0 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| warden | bun-test | 10.27 s | 92.0 MB | 129.3 MB |
| warden | warden-simd | 35.39 s | 55.7 MB | 56.2 MB |
| warden | warden-cli | 0.13 s | 82.2 KB | 77.7 MB |
| warden | other | 0.47 s | 21.7 KB | 20.5 MB |
| argent | other | 14.69 s | 182.0 MB | 261.8 MB |
| agent-device | other | 73.33 s | 745.9 MB | 2.4 GB |
| tester-army | other | 107.19 s | 599.5 MB | 2.0 GB |

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

### argent

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| simulator-server | host | 2.50 s | 92.0% | 96.6 MB | 96.7 MB | 1 |
| node argent | host | 0.21 s | 7.8% | 85.7 MB | 87.9 MB | 1 |
| node argent (exit charge) | host | 0.01 s | 0.2% | 0 B | 0 B | 0 |
| (node) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| node tool-server.cjs | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| simctl | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| system_profiler | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 98.77 s | 74.0% | 34.8 GB | 34.9 GB | 287 |
| wardenexample | sim | 29.50 s | 22.1% | 375.5 MB | 435.1 MB | 8 |
| bun cli.ts | sim | 2.78 s | 2.1% | 298.6 MB | 308.0 MB | 1 |
| simctl | sim | 0.41 s | 0.3% | 363.8 KB | 20.5 MB | 7 |
| CoreSimulatorBridge | sim | 0.40 s | 0.3% | 117.8 MB | 118.2 MB | 1 |
| launchd_sim | sim | 0.37 s | 0.3% | 52.2 MB | 52.2 MB | 1 |
| ps | sim | 0.29 s | 0.2% | 1.9 MB | 2.0 MB | 260 |
| (mlhostd) | sim | 0.26 s | 0.2% | 222.5 KB | 40.5 MB | 2 |
| triald | sim | 0.20 s | 0.1% | 96.7 MB | 96.7 MB | 1 |
| storekitd | sim | 0.19 s | 0.1% | 128.4 MB | 128.4 MB | 1 |
| (managedappdistri) | sim | 0.14 s | 0.1% | 214.5 KB | 54.5 MB | 1 |
| mlhostd | sim | 0.13 s | 0.1% | 119.3 KB | 15.7 MB | 2 |
| other | sim | 0.05 s | 0.0% | 444.5 MB | 453.2 MB | 9 |

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

- **warden:** none
- **argent:** paths: /Users/expo/.argent (328.0 KB)
- **agent-device:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/agent-device (2.9 MB)
- **tester-army:** driver apps: com.callstack.agentdevice.runner.uitests.xctrunner; paths: /Users/expo/.agent-device-bench/tester-army (4.9 MB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `bench-2026-10-25-ios-eas`.
