# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 5.09
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `9AECFBA5-3281-4058-B4FA-9E80053A1546`
- **App:** `nz.co.delacour.warden.example`, hash `import:2d35643eda49`, sha256 `2d35643eda49`, 96.4 MB
- **Options:** runs 5, retries 0, reboot between no, caffeinated yes
- **Frameworks:** argent 0.30.1

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
| argent | ok | 0.30.1 | **131.81 s** | 132.14 s | 1.00× | 132.43 s | 2.35 s | 1.73 s | 511 ms | 168 ms | 100% | 0% | 0 proc / 0 app / 1 path | 161 LOC / 0 B |

## Per-test medians (ms)

| Test | argent |
| --- | --- |
| onboarding steps through to sign-in | **8220 (1.00×)** |
| invalid email and short password show field errors | **17962 (1.00×)** |
| a locked account shows the form alert | **14040 (1.00×)** |
| valid credentials land on todos | **14982 (1.00×)** |
| add, complete and filter todos | **20867 (1.00×)** |
| open a todo, mark it done, then delete it | **18881 (1.00×)** |
| deep link opens a todo by id | **17367 (1.00×)** |
| settings shows the account, toggles switches and signs out | **19116 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| argent | 1192 | 318 ms | 1.82 s | 2.82 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

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

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| argent | host | 2.79 s | 14.69 s | 1.7% | 39.7% | 182.0 MB | 261.8 MB |
| argent | sim | — | 956.48 s | 131.3% | 788.2% | 36.3 GB | 36.5 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| argent | other | 14.69 s | 182.0 MB | 261.8 MB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

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

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **argent:** paths: /Users/expo/.argent (328.0 KB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-argent`.
