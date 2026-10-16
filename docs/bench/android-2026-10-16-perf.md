# e2e framework benchmark — android 2026-10-16, after WDN-PERF

- **Host:** Mac16,7, Apple M4 Pro, 14 cores, 48.0 GB RAM, macOS 26.6.2
- **Toolchain:** Xcode 26.6, Java 21.0.10, Node 22.22.2, bun 1.3.14, warden 0.1.0
- **Host load at start:** 5.05
- **Device:** sdk_gphone16k_arm64 (android, Android 17), udid `emulator-5554`
- **App:** `nz.co.delacour.warden.example`, hash `0e2ce8040258aff2dff1202cd8afbfd68f36087f`, sha256 `17df0fa5b473`, 104.9 MB
- **Options:** runs 3, retries 0, reboot between no, caffeinated yes
- **Frameworks:** warden bun 1.3.14 + warden-e2e, maestro maestro 2.8.0, argent 0.27.0, agent-device agent-device 0.21.25, tester-army e2e 0.20.0, detox detox 20.51.3

## After WDN-PERF

Same host, emulator image and unchanged suite (`packages/e2e-bench/suites/warden` is byte-identical to the baseline) as [`v2-android-r2`](android-2026-10-16.md), run on `feature/warden-perf` (plan: `docs/plans/wdn-perf.md`). The Android driver now reads the screen and sends input through `warden-uiad`, a resident UiAutomation server (PERF-3.3), instead of one `uiautomator dump` (~1.9 s) per read. The app is rebuilt from identical `apps/example` source (v2 fingerprint key, PERF-4.6); within this run every framework drove the same `.apk`.

| | `v2-android-r2` | `perf-android-r3` | Delta |
| --- | --- | --- | --- |
| warden warm suite | 465.00 s, 91.7% pass | **29.07 s, 100% pass** | −93.7% |
| ratio to the fastest clean framework (tester-army) | 6.09× | 0.36× | |
| step latency median / p95 | — | 47 ms / 415 ms | |
| host CPU-seconds per rep (CPU avg × suite) | ~2.8 s | ~0.9 s | −69% |

Every warden test got 89.1–98.3% faster. The other frameworks moved −0.6% to +6.1%.

Read with care:
- **Host CPU avg 3.0%** (was 0.6%) and **device CPU avg 49.6%** (was 5.9%) are averages over a suite that is 16× shorter: the same work packed into 29 s, plus the server on the emulator.
- `warden-uiad` is verified on this image only (API 37).
- Untraced time is 7.67 s per rep (26.5% of test time), largest in settings (3.53 s): the next thing to trace.

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
| warden | ok | bun 1.3.14 + warden-e2e | **29.07 s** | 31.19 s | 1.00× | 27.10 s | none (rep 1 not slower, -1.97 s) | 0 ms | 0 ms | 113 ms | 100% | 0% | 0 proc / 0 app / 0 path | 309 LOC / 0 B |
| maestro | ok | maestro 2.8.0 | 274.36 s ✗ | 274.82 s | 9.44× | 273.58 s | none (rep 1 not slower, -786 ms) | 0 ms | 37 ms | 4.87 s | 87.5% | 12.5% | 0 proc / 2 app / 1 path | 272 LOC / 0 B |
| argent | unsupported | 0.27.0 | — | — | — | — | — | — | — | — | — | — | — | — |
| agent-device | ok | agent-device 0.21.25 | 48.88 s ✗ | 48.97 s | 1.68× | 109.65 s | 60.77 s | 0 ms | 99 ms | 1.95 s | 83.3% | 16.7% | 0 proc / 0 app / 1 path | 158 LOC / 0 B |
| tester-army | ok | e2e 0.20.0 | 81.05 s | 82.17 s | 2.79× | 81.37 s | 315 ms | 0 ms | 254 ms | 2.95 s | 100% | 0% | 0 proc / 0 app / 1 path | 307 LOC / 0 B |
| detox | unsupported | detox 20.51.3 | — | — | — | — | — | — | — | — | — | — | — | — |

## Per-test medians (ms)

| Test | warden | maestro | argent | agent-device | tester-army | detox |
| --- | --- | --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | **1414 (1.00×)** | 9500 (6.72×) | — | 2693 ✗ (1.90×) | 5066 (3.58×) | — |
| invalid email and short password show field errors | **3321 (1.00×)** | 44609 (13.43×) | — | 7070 (2.13×) | 9501 (2.86×) | — |
| a locked account shows the form alert | **2016 (1.00×)** | 26954 (13.37×) | — | 4102 (2.03×) | 6190 (3.07×) | — |
| valid credentials land on todos | **2714 (1.00×)** | 27749 (10.22×) | — | 4837 (1.78×) | 8709 (3.21×) | — |
| add, complete and filter todos | **3953 (1.00×)** | 54895 ✗ (13.89×) | — | 6790 (1.72×) | 11133 (2.82×) | — |
| open a todo, mark it done, then delete it | **4750 (1.00×)** | 35494 (7.47×) | — | 7329 (1.54×) | 11541 (2.43×) | — |
| deep link opens a todo by id | **4080 (1.00×)** | 28794 (7.06×) | — | 5154 (1.26×) | 11475 (2.81×) | — |
| settings shows the account, toggles switches and signs out | **6712 (1.00×)** | 41496 (6.18×) | — | 8962 ✗ (1.34×) | 14488 (2.16×) | — |

## Per-step latency

| Framework | Steps | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| warden | 259 | 47 ms | 415 ms | 945 ms |
| maestro | 338 | 2.12 s | 3.15 s | 17.07 s |
| agent-device | 302 | 164 ms | 1.17 s | 4.03 s |
| tester-army | 288 | 146 ms | 2.27 s | 2.46 s |

## Untraced time

| Framework | Untraced / rep | Share of test time | Largest (test) |
| --- | --- | --- | --- |
| warden | 7.67 s | 26.5% | settings/account-switches-sign-out (3.53 s) |

Test wall time that no step and no span of the framework's own trace covers (warden: `trace.jsonl`; nested steps and spans count once). Runner overhead, hooks, sleeps and calls nobody wrapped end up here.

## Resources

| Framework | Scope | CPU avg | CPU peak | RSS avg | RSS peak |
| --- | --- | --- | --- | --- | --- |
| warden | host | 3.0% | 22.1% | 118.2 MB | 133.5 MB |
| warden | sim | 49.6% | 103.0% | 383.0 MB | 443.0 MB |
| maestro | host | 6.0% | 296.1% | 399.2 MB | 490.9 MB |
| maestro | sim | 16.4% | 124.0% | 591.5 MB | 630.0 MB |
| agent-device | host | 4.2% | 86.1% | 179.8 MB | 259.5 MB |
| agent-device | sim | 18.4% | 80.7% | 675.7 MB | 873.0 MB |
| tester-army | host | 2.5% | 63.2% | 318.0 MB | 521.9 MB |
| tester-army | sim | 18.1% | 116.0% | 565.1 MB | 801.0 MB |

Sampled every 500 ms from `ps`. `host` = the framework's own process tree; `sim` = every process of the simulator's `launchd_sim` tree, or on Android the app under test plus every framework's on-device helpers from `top` (every 2 s). RSS is a per-process sum, so shared framework pages are counted once per process: compare the numbers across frameworks, not against physical memory.

## Residue

- **warden:** none
- **maestro:** driver apps: dev.mobile.maestro, dev.mobile.maestro.test; paths: /Users/chris/.maestro (780.0 KB)
- **agent-device:** paths: /Users/chris/.agent-device-bench/agent-device (548.0 KB)
- **tester-army:** paths: /Users/chris/.agent-device-bench/tester-army (1.8 MB)

## Unsupported / failed

- **argent:** unsupported. argent found no gRPC registration for emulator-5554 (avd/running/pid_*.ini with grpc.port + grpc.token); warden launches emulators -read-only and headless, which register none
- **detox:** unsupported. detox android needs an instrumented build; set BENCH_DETOX_ANDROID=1 after applying @config-plugins/detox (WDN-BENCH-A6b)

---

Generated by @delacour/warden-e2e-bench schema v1, run `perf-android-r3`.
