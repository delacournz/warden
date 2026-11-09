---
"@delacour/warden": patch
---

- Tests skipped when collected (`test.skip`, `test.skipIf(true)`, `platforms` that leave out the device's platform, `requires` the device lacks) now get a `skipped` line in `results.jsonl` with code `SKIPPED` and the reason, so `warden e2e` counts them in its skipped total instead of reporting `0 skipped`
