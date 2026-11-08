---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch`: each finished-test log line now shows the run's total so far next to the test's own time, e.g. `✓ settings › signs out (15.26s · total 41s)`; the total counts from when the first spec started.
- `warden e2e` ends with a line splitting the run's wall time, `took 2m52s — setup 1m24s · tests 1m26s · teardown 2s`, and `e2e-report.json` records it as `timing` (`totalMs`, `setupMs`, `testsMs`, `teardownMs`).
