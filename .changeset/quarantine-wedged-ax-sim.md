---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch` on iOS: a simulator whose accessibility service was found wedged and whose reads still time out at the end of the warm-up (recovery failed, or recovered yet still not answering) no longer runs specs that can only time out. It is dropped before its first job, its specs go to the other devices, and it is quarantined like `warden release --bad` so later claims skip it (`warden sim unquarantine <udid>` gives it back). Only warden's own devices are quarantined.
- When every device of a run is dropped this way, the run fails with `no device left to run N jobs` instead of passing on nothing.
- `e2e-report.json` `warm[]` entries gain `dropped` and `quarantined`.
