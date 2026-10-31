---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch` no longer fail a passing spec because another spec in the same shard failed or because a skipped spec had no result; only the spec with the failed test (or a spec the process never reached after a crash) fails.
