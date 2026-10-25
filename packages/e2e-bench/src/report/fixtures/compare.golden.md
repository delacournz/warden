# e2e framework benchmark — compare

- **A:** `bench-2026-10-16-ios-a1b2c3` (2026-10-16)
- **B:** `bench-2026-10-17-ios-d4e5f6` (2026-10-17)

## Suite median (warm)

| Framework | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| warden | 61.41 s | 67.55 s | +6.14 s | +10.0% |
| agent-device | 133.78 s | 147.16 s | +13.38 s | +10.0% |
| tester-army | — | — | — | — |

## Per-test: warden

| Test | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | 6.27 s | 6.90 s | +627 ms | +10.0% |
| invalid email and short password show field errors | 5.13 s | 5.65 s | +513 ms | +10.0% |
| a locked account shows the form alert | 4.29 s | 4.72 s | +429 ms | +10.0% |
| valid credentials land on todos | 6.95 s | 7.64 s | +695 ms | +10.0% |
| add, complete and filter todos | 8.40 s | 9.24 s | +840 ms | +10.0% |
| open a todo, mark it done, then delete it | 9.32 s | 10.25 s | +932 ms | +10.0% |
| deep link opens a todo by id | 6.03 s | 6.64 s | +603 ms | +10.0% |
| settings shows the account, toggles switches and signs out | 5.20 s | 5.72 s | +520 ms | +10.0% |

## Per-test: agent-device

| Test | A | B | Delta | Delta % |
| --- | --- | --- | --- | --- |
| onboarding steps through to sign-in | 12.75 s | 14.02 s | +1.27 s | +10.0% |
| invalid email and short password show field errors | 10.60 s | 11.66 s | +1.06 s | +10.0% |
| a locked account shows the form alert | 9.10 s | 10.01 s | +910 ms | +10.0% |
| valid credentials land on todos | 14.82 s | 16.30 s | +1.48 s | +10.0% |
| add, complete and filter todos | 17.49 s | 19.24 s | +1.75 s | +10.0% |
| open a todo, mark it done, then delete it | 19.97 s | 21.96 s | +2.00 s | +10.0% |
| deep link opens a todo by id | 13.19 s | 14.50 s | +1.32 s | +10.0% |
| settings shows the account, toggles switches and signs out | 10.71 s | 11.78 s | +1.07 s | +10.0% |

## Status changes

- **tester-army:** failed → unsupported

## Only in A

- argent

## Only in B

None.
