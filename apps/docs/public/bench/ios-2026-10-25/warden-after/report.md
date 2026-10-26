# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 16.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.1.1
- **Host load at start:** 4.24
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `6A9A3A44-CC76-4F8F-8212-8D690E7969B9`
- **App:** `nz.co.delacour.warden.example`, hash `import:c283eae41c7a`, sha256 `c283eae41c7a`, 96.4 MB
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
| warden | ok | bun 1.3.14 + warden-e2e | **91.89 s** | 94.65 s | 1.00× | 89.75 s | none (rep 1 not slower, -1.35 s) | 800 ms | 76 ms | 94 ms | 100% | 0% | 0 proc / 0 app / 0 path | 379 LOC / 0 B |

## Per-test medians (ms)

| Test | warden |
| --- | --- |
| onboarding steps through to sign-in | **2990 (1.00×)** |
| invalid email and short password show field errors | **17521 (1.00×)** |
| a locked account shows the form alert | **10814 (1.00×)** |
| valid credentials land on todos | **10564 (1.00×)** |
| add, complete and filter todos | **15780 (1.00×)** |
| open a todo, mark it done, then delete it | **11437 (1.00×)** |
| deep link opens a todo by id | **10812 (1.00×)** |
| settings shows the account, toggles switches and signs out | **12019 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 504 | 107 ms | 3.95 s | 5.19 s |

### Where step time goes

Step scopes differ per tool: warden's one `fill` step spans the focus tap, select-all, typing and read-back confirm, argent reports a separate `idle` step and `into …`, agent-device reports `fill` and `type` separately, and tester.army reports locator steps. Compare a verb's share within a tool, not its median across tools.

**warden**

| Verb | n | Share | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| fill | 68 | 79.2% | 3.55 s | 4.55 s | 5.19 s |
| tap | 180 | 10.9% | 95 ms | 343 ms | 728 ms |
| expect | 256 | 9.9% | 22 ms | 626 ms | 639 ms |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 3.15 s | 3.4% | sign-in/field-errors (715 ms) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warden | host | 3.79 s | 19.43 s | 2.9% | 41.8% | 146.1 MB | 177.6 MB |
| warden | sim | — | 821.41 s | 164.0% | 822.3% | 33.3 GB | 33.5 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| warden | bun-test | 9.85 s | 90.6 MB | 122.7 MB |
| warden | warden-simd | 8.95 s | 55.3 MB | 58.3 MB |
| warden | warden-cli | 0.14 s | 158.1 KB | 79.0 MB |
| warden | other | 0.48 s | 30.9 KB | 17.3 MB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### warden

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| warden-simd | host | 1.83 s | 48.5% | 55.6 MB | 55.6 MB | 1 |
| bun test | host | 1.09 s | 28.9% | 88.4 MB | 101.9 MB | 1 |
| (bun) (exit charge) | host | 0.55 s | 14.6% | 0 B | 0 B | 0 |
| simctl | host | 0.19 s | 5.0% | 276.1 KB | 20.5 MB | 4 |
| (simctl) | host | 0.09 s | 2.4% | 209.5 KB | 20.3 MB | 2 |
| (bun) | host | 0.02 s | 0.5% | 0 B | 0 B | 0 |
| (ps) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| bun cli.ts | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| iOS | sim | 59.59 s | 58.8% | 31.8 GB | 31.9 GB | 291 |
| wardenexample | sim | 31.06 s | 30.6% | 374.2 MB | 429.8 MB | 8 |
| SimulatorFrameworkBridge-iOS serve | sim | 5.92 s | 5.8% | 198.1 MB | 210.8 MB | 12 |
| bun cli.ts | sim | 2.23 s | 2.2% | 246.9 MB | 251.9 MB | 1 |
| CoreSimulatorBridge | sim | 1.05 s | 1.0% | 79.6 MB | 79.7 MB | 1 |
| ps | sim | 0.41 s | 0.4% | 1.9 MB | 1.9 MB | 184 |
| launchd_sim | sim | 0.38 s | 0.4% | 26.1 MB | 26.1 MB | 1 |
| xpcproxy_sim | sim | 0.19 s | 0.2% | 319.6 KB | 12.3 MB | 8 |
| (mlhostd) | sim | 0.15 s | 0.1% | 87.8 KB | 15.8 MB | 1 |
| (wardenexample) | sim | 0.14 s | 0.1% | 4.7 MB | 434.7 MB | 2 |
| storekitd | sim | 0.09 s | 0.1% | 124.8 MB | 124.8 MB | 1 |
| triald | sim | 0.09 s | 0.1% | 85.1 MB | 85.1 MB | 1 |
| other | sim | 0.07 s | 0.1% | 378.2 MB | 395.3 MB | 7 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **warden:** none

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-warden`.
