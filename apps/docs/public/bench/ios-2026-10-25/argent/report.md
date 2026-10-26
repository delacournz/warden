# e2e framework benchmark — ios 2026-10-25

- **Host:** VirtualMac2,1, Apple M4 Pro (Virtual), 10 cores, 40.0 GB RAM, macOS 26.5.2
- **Toolchain:** Xcode 26.6, Java 17.0.19, Node 22.23.1, bun 1.3.14, warden 0.3.1
- **Host load at start:** 2.49
- **Device:** warden-iphone-17-1 (ios, iOS 26.5), udid `1EC7DDB8-41DB-4011-B176-759305DCD93E`
- **App:** `nz.co.delacour.warden.example`, hash `import:c283eae41c7a`, sha256 `c283eae41c7a`, 96.4 MB
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
| argent | ok | 0.30.1 | **134.32 s** | 134.65 s | 1.00× | 133.61 s | 1.01 s | 1.72 s | 293 ms | 163 ms | 100% | 0% | 0 proc / 0 app / 1 path | 161 LOC / 0 B |

## Per-test medians (ms)

| Test | argent |
| --- | --- |
| onboarding steps through to sign-in | **8301 (1.00×)** |
| invalid email and short password show field errors | **18221 (1.00×)** |
| a locked account shows the form alert | **14442 (1.00×)** |
| valid credentials land on todos | **15416 (1.00×)** |
| add, complete and filter todos | **21110 (1.00×)** |
| open a todo, mark it done, then delete it | **19105 (1.00×)** |
| deep link opens a todo by id | **17811 (1.00×)** |
| settings shows the account, toggles switches and signs out | **19616 (1.00×)** |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| argent | 1192 | 321 ms | 1.82 s | 2.82 s |

## Resources

| Framework | Scope | CPU-s / rep | CPU-s (whole) | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| argent | host | 4.13 s | 21.38 s | 2.7% | 41.8% | 181.4 MB | 236.7 MB |
| argent | sim | — | 325.71 s | 44.5% | 209.9% | 10.5 GB | 10.6 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

`CPU-s / rep` (the CPU headline) is the CPU time of the timed run only, median over the warm reps (over every rep, cold included, when a framework has no warm rep, as with `--runs 1`), from per-process deltas of `ps time`; the other columns are whole-framework (prepare, every rep, the per-rep housekeeping and teardown), so their averages move with suite length. `CPU avg` / `CPU peak` are `ps %cpu`, a decaying average on macOS, kept for comparison with older runs. Android `sim` has no CPU-seconds (`top` only). CPU-seconds undercount: CPU a process uses after the last 500 ms tick, and processes living between ticks, are only recovered for children the bench ran itself (their rusage at exit); daemons and processes a framework spawns and never waits for are not, so frameworks that fan out to many short-lived tools read low. An exit charge is booked to its root's group, so in the per-group split the unseen CPU of a descendant of another group (a `bun test` under a `warden` root) shows under the root. procps (Linux) `ps time` has 1 s resolution.

### Host by process group

| Framework | Group | CPU-s (whole) | RSS avg | RSS peak |
| --- | --- | --- | --- | --- |
| argent | other | 21.38 s | 181.4 MB | 236.7 MB |

`bun-test` the spec process, `warden-simd` the resident iOS helper, `warden-cli` the `warden` commands the bench spawned, `adb` / `emulator` the Android tools, `other` the rest (another framework's runner, `xcrun`, java). Each group's RSS average counts 0 for ticks without a process, so the groups add up to the host.

## Where the CPU goes

### argent

| Process | Scope | CPU-s | Share | RSS avg | RSS peak | Spawns |
| --- | --- | --- | --- | --- | --- | --- |
| simulator-server | host | 3.92 s | 95.6% | 96.0 MB | 96.0 MB | 1 |
| node argent | host | 0.18 s | 4.3% | 85.7 MB | 88.1 MB | 1 |
| node argent (exit charge) | host | 0.00 s | 0.1% | 0 B | 0 B | 0 |
| (simctl) | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| node tool-server.cjs | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| simctl | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| system_profiler | host | 0.00 s | 0.0% | 0 B | 0 B | 0 |
| wardenexample | sim | 33.67 s | 52.9% | 374.7 MB | 434.8 MB | 8 |
| iOS | sim | 24.31 s | 38.2% | 9.7 GB | 9.7 GB | 106 |
| bun cli.ts | sim | 3.34 s | 5.2% | 225.2 MB | 229.3 MB | 1 |
| ps | sim | 1.07 s | 1.7% | 1.8 MB | 1.8 MB | 267 |
| CoreSimulatorBridge | sim | 0.48 s | 0.8% | 117.8 MB | 118.2 MB | 1 |
| simctl | sim | 0.41 s | 0.6% | 351.9 KB | 20.5 MB | 5 |
| launchd_sim | sim | 0.21 s | 0.3% | 36.9 MB | 36.9 MB | 1 |
| xpcproxy_sim | sim | 0.15 s | 0.2% | 155.7 KB | 12.1 MB | 4 |
| (wardenexample) | sim | 0.04 s | 0.1% | 1.5 MB | 395.3 MB | 1 |
| pkd | sim | 0.00 s | 0.0% | 59.0 MB | 59.0 MB | 1 |
| aslmanager | sim | 0.00 s | 0.0% | 21.1 MB | 21.1 MB | 1 |
| caffeinate | sim | 0.00 s | 0.0% | 7.2 MB | 7.2 MB | 1 |
| other | sim | 0.00 s | 0.0% | 0 B | 0 B | 0 |

One table per framework, from the warm-median rep's timed run (the rep whose host CPU-seconds is the lower median). Rows are processes grouped by label (top 12 per scope, the rest in `other`); `host` is the framework's own process tree, `sim` the simulator's `launchd_sim` tree (iOS only). `Share` is of the scope's CPU-seconds. `RSS` is the label's summed RSS per 500 ms tick (0 where it had no process). `Spawns` counts distinct pids a tick saw: a process that lives between two ticks is only seen through the `(exit charge)` rows (CPU of a child the bench ran, booked at its exit), so many short-lived `xcrun simctl` calls read low in `Spawns` and in CPU.

## Residue

- **argent:** paths: /Users/expo/.argent (328.0 KB)

## Unsupported / failed

None.

---

Generated by @delacour/warden-e2e-bench schema v1, run `eas-ios-argent`.
