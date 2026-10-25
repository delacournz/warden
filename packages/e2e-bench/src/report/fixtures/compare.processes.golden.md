# e2e framework benchmark — compare

- **A:** `bench-2026-10-16-ios-a1b2c3` (2026-10-16)
- **B:** `bench-2026-10-16-ios-a1b2c3` (2026-10-16)

## Suite median (warm)

| Framework | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| warden | 61.41 s | 61.41 s | 0 ms | 0.0% |
| argent | 112.67 s | 112.67 s | 0 ms | 0.0% |
| agent-device | 133.78 s | 133.78 s | 0 ms | 0.0% |
| tester-army | — | — | — | — |

## Host CPU-seconds per rep (warm)

| Framework | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| warden | 2.50 s | 2.50 s | 0.00 s | 0.0% |
| argent | 2.50 s | 2.50 s | 0.00 s | 0.0% |
| agent-device | 2.50 s | 2.50 s | 0.00 s | 0.0% |

## Where the CPU goes: warden

| Process | Scope | A CPU-s | B CPU-s | Delta | A RSS peak | B RSS peak |
| --- | --- | --- | --- | --- | --- | --- |
| bun test | host | 0.92 s | 0.46 s | -0.46 s | 101.0 MB | 101.0 MB |
| warden-simd | host | 0.54 s | 0.00 s | -0.54 s | 34.0 MB | 34.0 MB |
| SimulatorFrameworkBridge-iOS serve | host | 0.32 s | 0.32 s | 0.00 s | 24.0 MB | 24.0 MB |
| xcrun simctl launch | host | 0.14 s | 0.14 s | 0.00 s | 9.0 MB | 9.0 MB |
| simctl | host | 0.08 s | 0.08 s | 0.00 s | 6.0 MB | 6.0 MB |
| backboardd | sim | 2.28 s | 2.28 s | 0.00 s | 90.0 MB | 90.0 MB |
| Example | sim | 1.86 s | 1.86 s | 0.00 s | 341.0 MB | 341.0 MB |
| SpringBoard | sim | 1.08 s | 1.08 s | 0.00 s | 154.0 MB | 154.0 MB |
| launchd_sim | sim | 0.78 s | 0.78 s | 0.00 s | 45.0 MB | 45.0 MB |

## Where the CPU goes: argent

| Process | Scope | A CPU-s | B CPU-s | Delta | A RSS peak | B RSS peak |
| --- | --- | --- | --- | --- | --- | --- |
| node tool-server.cjs | host | 1.40 s | 1.40 s | 0.00 s | 154.0 MB | 154.0 MB |
| bun test | host | 0.40 s | 0.20 s | -0.20 s | 66.0 MB | 66.0 MB |
| xcrun simctl io | host | 0.20 s | 0.20 s | 0.00 s | 7.0 MB | 7.0 MB |
| backboardd | sim | 2.28 s | 2.28 s | 0.00 s | 90.0 MB | 90.0 MB |
| Example | sim | 1.86 s | 1.86 s | 0.00 s | 341.0 MB | 341.0 MB |
| SpringBoard | sim | 1.08 s | 1.08 s | 0.00 s | 154.0 MB | 154.0 MB |
| launchd_sim | sim | 0.78 s | 0.78 s | 0.00 s | 45.0 MB | 45.0 MB |

## Where the CPU goes: agent-device

| Process | Scope | A CPU-s | B CPU-s | Delta | A RSS peak | B RSS peak |
| --- | --- | --- | --- | --- | --- | --- |
| node daemon.js | host | 1.10 s | 1.10 s | 0.00 s | 341.0 MB | 341.0 MB |
| xcodebuild | host | 0.70 s | 0.70 s | 0.00 s | 308.0 MB | 308.0 MB |
| bun test | host | 0.20 s | 0.10 s | -0.10 s | 55.0 MB | 55.0 MB |
| backboardd | sim | 2.28 s | 2.28 s | 0.00 s | 90.0 MB | 90.0 MB |
| Example | sim | 1.86 s | 1.86 s | 0.00 s | 341.0 MB | 341.0 MB |
| SpringBoard | sim | 1.08 s | 1.08 s | 0.00 s | 154.0 MB | 154.0 MB |
| launchd_sim | sim | 0.78 s | 0.78 s | 0.00 s | 45.0 MB | 45.0 MB |

## Per-test: warden

| Test | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | 6.27 s | 6.27 s | 0 ms | 0.0% |
| invalid email and short password show field errors | 5.13 s | 5.13 s | 0 ms | 0.0% |
| a locked account shows the form alert | 4.29 s | 4.29 s | 0 ms | 0.0% |
| valid credentials land on todos | 6.95 s | 6.95 s | 0 ms | 0.0% |
| add, complete and filter todos | 8.40 s | 8.40 s | 0 ms | 0.0% |
| open a todo, mark it done, then delete it | 9.32 s | 9.32 s | 0 ms | 0.0% |
| deep link opens a todo by id | 6.03 s | 6.03 s | 0 ms | 0.0% |
| settings shows the account, toggles switches and signs out | 5.20 s | 5.20 s | 0 ms | 0.0% |

## Per-test: argent

| Test | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | 10.98 s | 10.98 s | 0 ms | 0.0% |
| invalid email and short password show field errors | 9.15 s | 9.15 s | 0 ms | 0.0% |
| a locked account shows the form alert | 7.69 s | 7.69 s | 0 ms | 0.0% |
| valid credentials land on todos | 12.55 s | 12.55 s | 0 ms | 0.0% |
| add, complete and filter todos | 15.36 s | 15.36 s | 0 ms | 0.0% |
| open a todo, mark it done, then delete it | 16.69 s | 16.69 s | 0 ms | 0.0% |
| deep link opens a todo by id | 10.92 s | 10.92 s | 0 ms | 0.0% |
| settings shows the account, toggles switches and signs out | 9.26 s | 9.26 s | 0 ms | 0.0% |

## Per-test: agent-device

| Test | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | 12.75 s | 12.75 s | 0 ms | 0.0% |
| invalid email and short password show field errors | 10.60 s | 10.60 s | 0 ms | 0.0% |
| a locked account shows the form alert | 9.10 s | 9.10 s | 0 ms | 0.0% |
| valid credentials land on todos | 14.82 s | 14.82 s | 0 ms | 0.0% |
| add, complete and filter todos | 17.49 s | 17.49 s | 0 ms | 0.0% |
| open a todo, mark it done, then delete it | 19.97 s | 19.97 s | 0 ms | 0.0% |
| deep link opens a todo by id | 13.19 s | 13.19 s | 0 ms | 0.0% |
| settings shows the account, toggles switches and signs out | 10.71 s | 10.71 s | 0 ms | 0.0% |

## Status changes

None.

## Only in A

None.

## Only in B

None.
