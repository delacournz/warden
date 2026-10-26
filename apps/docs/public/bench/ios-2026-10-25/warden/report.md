# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.3.1
- **Host load at start:** 2.87
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `733DA5E8-BA9B-4E4A-98FD-6CD76BA8C161`
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
| warden | ok | bun 1.3.14 + warden-e2e | **86.30 s** | 86.71 s | 1.00× | 71.98 s | none (rep 1 not slower, -13.72 s) | 596 ms | 72 ms | 67 ms | 100% | 0% | 0 proc / 0 app / 0 path | 379 LOC / 0 B |

## Per-test medians (ms)

| Test | warden |
| --- | --- |
| onboarding steps through to sign-in | **2929 (1.00×)** |
| invalid email and short password show field errors | **16054 (1.00×)** |
| a locked account shows the form alert | **10096 (1.00×)** |
| valid credentials land on todos | **9788 (1.00×)** |
| add, complete and filter todos | **14494 (1.00×)** |
| open a todo, mark it done, then delete it | **11089 (1.00×)** |
| deep link opens a todo by id | **10656 (1.00×)** |
| settings shows the account, toggles switches and signs out | **10945 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 504 | 85 ms | 3.63 s | 4.98 s |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 3.17 s | 3.7% | todo-detail/deep-link (716 ms) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warden | host | 2.97 s | 15.36 s | 3.0% | 38.8% | 145.9 MB | 158.6 MB |
| warden | sim | — | 329.55 s | 74.3% | 282.8% | 10.6 GB | 10.7 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| warden | bun-test | 6.21 s | 89.6 MB | 102.2 MB |
| warden | warden-simd | 8.61 s | 56.2 MB | 56.7 MB |
| warden | warden-cli | 0.11 s | 131.6 KB | 78.8 MB |
| warden | other | 0.43 s | 0 B | 0 B |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### warden

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| warden-simd | host | 1.76 s | 60.0% | 56.5 MB | 56.7 MB | 1 |
| bun test | host | 1.16 s | 39.5% | 90.1 MB | 101.3 MB | 1 |
| bun test (exit charge) | host | 0.01 s | 0.5% | 0 B | 0 B | 0 |
| bun cli.ts | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| simctl | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| wardenexample | sim | 32.07 s | 48.8% | 373.1 MB | 428.9 MB | 8 |
| iOS | sim | 25.41 s | 38.6% | 9.7 GB | 9.7 GB | 108 |
| SimulatorFrameworkBridge-iOS serve | sim | 3.53 s | 5.4% | 185.6 MB | 199.8 MB | 13 |
| bun cli.ts | sim | 2.28 s | 3.5% | 228.3 MB | 229.5 MB | 1 |
| CoreSimulatorBridge | sim | 1.25 s | 1.9% | 84.9 MB | 85.0 MB | 1 |
| ps | sim | 0.69 s | 1.0% | 1.8 MB | 1.8 MB | 171 |
| launchd_sim | sim | 0.33 s | 0.5% | 36.8 MB | 36.8 MB | 1 |
| xpcproxy_sim | sim | 0.22 s | 0.3% | 411.4 KB | 13.3 MB | 7 |
| pkd | sim | 0.00 s | 0.0% | 58.9 MB | 58.9 MB | 1 |
| aslmanager | sim | 0.00 s | 0.0% | 21.2 MB | 21.2 MB | 1 |
| caffeinate | sim | 0.00 s | 0.0% | 7.3 MB | 7.3 MB | 1 |
| (launchctl) | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| other | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **warden:** none

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-warden`.
