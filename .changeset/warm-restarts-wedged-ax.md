---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch` iOS warm-up: a freshly booted simulator whose accessibility service wedged on first use (every read timed out for the life of the boot, `did not answer within the query's 10.0s timeout`, warm-up `timed out after 120s`) is now detected from its log (`Could not auto-register for pid status change`) after the first failed snapshot and recovered: warden restarts backboardd once and reconnects a fresh helper, instead of running that device's specs cold until they fail. The warm-up log says `accessibility service wedged: restarted backboardd`.
- `e2e-report.json` gains `warm[]`: per iOS device `{ worker, udid, ok, error?, axRecovery? }`, with `axRecovery` `{ outcome: "recovered" }` or `{ outcome: "failed", error }`.
