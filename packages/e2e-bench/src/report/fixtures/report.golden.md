# e2e framework benchmark — ios 2026-10-16

- **Host:** MacBook Pro (16-inch, 2023), Apple M3 Max, 14 cores, 36.0 GB RAM, macOS 26.0 (25A354)
- **Toolchain:** Xcode 26.0.1, Java 21.0.5, Node 24.19.0, bun 1.3.14, warden 0.19.0
- **Host load at start:** 1.42
- **Device:** iPhone 17 Pro (ios, iOS 26.0), udid `9F3C2E7A-5B1D-4C88-A0E4-7D2B6C1F8E55`
- **App:** `nz.co.delacour.warden.example`, hash `3fa91c07b2de`, sha256 `9b4e1c7a52d0`, 59.0 MB
- **Options:** runs 3, retries 0, reboot between no, caffeinated yes
- **Frameworks:** warden 0.19.0, maestro 2.0.9, argent 0.11.2, agent-device 0.7.4, tester-army 0.20.0, detox —

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
- Android `sim` counts the app and every framework's on-device helpers (uiautomator, instrumentation runners, Maestro, agent-device, Argent, warden-uiad), matched case-insensitively
- Host processes are tracked by pid and start time, so a reused pid is never counted
- Android animation scales are reset to the device's original values before every framework and restored at the end

## Summary

| Framework | Status | Version | Suite median (warm) | p95 | Ratio | Cold rep 1 | Cold-start cost | Prepare | Teardown | Overhead | Pass rate | Flake | Residue | Footprint (LOC / deps) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warden | ok | 0.19.0 | **61.41 s** | 61.48 s | 1.00× | 80.25 s | 21.14 s | 2.30 s | 600 ms | 9.82 s | 100% | 0% | 0 proc / 0 app / 0 path | 412 LOC / 0 B |
| maestro | ok | 2.0.9 | 96.76 s | 97.01 s | 1.58× | 126.19 s | 38.63 s | 9.20 s | 1.80 s | 19.66 s | 100% | 0% | 2 proc / 1 app / 1 path | 336 LOC / 0 B |
| argent | ok | 0.11.2 | 112.67 s | 113.11 s | 1.83× | 147.26 s | 38.69 s | 4.10 s | 900 ms | 20.07 s | 100% | 0% | 0 proc / 0 app / 0 path | 298 LOC / 0 B |
| agent-device | ok | 0.7.4 | 133.78 s | 134.03 s | 2.18× | 175.62 s | 47.44 s | 5.60 s | 1.20 s | 25.17 s | 100% | 0% | 1 proc / 1 app / 1 path | 354 LOC / 30.0 MB |
| tester-army | failed | 0.20.0 | — | — | — | — | — | — | — | — | — | — | — | — |
| detox | unsupported | — | — | — | — | — | — | — | — | — | — | — | — | — |

## Per-test medians (ms)

| Test | warden | maestro | argent | agent-device | tester-army | detox |
| --- | --- | --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | **6270 (1.00×)** | 9212 (1.47×) | 10985 (1.75×) | 12747 (2.03×) | — | — |
| invalid email and short password show field errors | **5132 (1.00×)** | 7639 (1.49×) | 9148 (1.78×) | 10602 (2.07×) | — | — |
| a locked account shows the form alert | **4293 (1.00×)** | 6447 (1.50×) | 7688 (1.79×) | 9101 (2.12×) | — | — |
| valid credentials land on todos | **6946 (1.00×)** | 10579 (1.52×) | 12550 (1.81×) | 14818 (2.13×) | — | — |
| add, complete and filter todos | **8404 (1.00×)** | 12645 (1.50×) | 15357 (1.83×) | 17491 (2.08×) | — | — |
| open a todo, mark it done, then delete it | **9318 (1.00×)** | 13715 (1.47×) | 16692 (1.79×) | 19966 (2.14×) | — | — |
| deep link opens a todo by id | **6033 (1.00×)** | 9147 (1.52×) | 10921 (1.81×) | 13185 (2.19×) | — | — |
| settings shows the account, toggles switches and signs out | **5198 (1.00×)** | 7718 (1.48×) | 9259 (1.78×) | 10705 (2.06×) | — | — |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 98 | 939 ms | 1.98 s | 2.23 s |
| maestro | 98 | 1.46 s | 2.97 s | 3.56 s |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 10.32 s | 20% | todo-detail/open-toggle-delete (1.86 s) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- |
| warden | host | 21.4% | 96.3% | 210.0 MB | 260.0 MB |
| warden | sim | 31.7% | 140.2% | 1.4 GB | 1.6 GB |
| maestro | host | 38.2% | 212.5% | 640.0 MB | 910.0 MB |
| maestro | sim | 31.7% | 140.2% | 1.4 GB | 1.6 GB |
| argent | host | 21.4% | 96.3% | 210.0 MB | 260.0 MB |
| argent | sim | 31.7% | 140.2% | 1.4 GB | 1.6 GB |
| agent-device | host | 38.2% | 212.5% | 640.0 MB | 910.0 MB |
| agent-device | sim | 31.7% | 140.2% | 1.4 GB | 1.6 GB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

## Residue

- **warden:** none
- **maestro:** processes: java (maestro), maestro-driver; driver apps: dev.mobile.maestro-driver-iosUITests.xctrunner; paths: ~/.maestro (18.0 MB)
- **argent:** none
- **agent-device:** processes: agent-device daemon; driver apps: com.callstack.agentdevice.runner.xctrunner; paths: ~/.agent-device (4.0 MB)

## Unsupported / failed

- **tester-army:** failed in phase `run`. parity breach: unmapped tests: sign-in › accepts any email (not in manifest)
- **detox:** unsupported. Detox 20 attach failed on RN 0.86 (Fabric idling resources hang); timed out after 120 s

---

Generated by @delacour/warden-e2e-bench schema v1, run `bench-2026-10-16-ios-a1b2c3`.
