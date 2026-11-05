---
"@delacour/warden": minor
---

- `warden e2e` prints a tail of the app's native log (at most 20 lines, errors and faults first, unresolved `<compose failure>` lines skipped) under a failed test; the full `native.log` stays in the evidence folder.
- iOS `native.log` now includes info and debug lines, and warden makes sure the simulator keeps private values readable (`log config --mode private_data:on`) before the app runs. `WARDEN_NATIVE_LOG_PRIVATE=0` opts out.
- A `native.log` whose messages mostly could not be resolved (`<compose failure>`) is noted in the trace as `native log: N of M messages unresolved`.
