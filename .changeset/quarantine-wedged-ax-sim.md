---
"@delacour/warden": patch
---

- `warden e2e` / `warden batch` on iOS: a simulator whose accessibility service was found wedged and whose reads still time out at the end of the warm-up (recovery failed, or recovered or rebooted yet still not answering) no longer runs specs that can only time out. It is dropped before its first job, its specs go to the other devices, and it is quarantined for 24 hours with a `warm: ` reason so claims skip it; like health-probe quarantines it lifts on its own after that, since a later boot clears the wedge (`warden sim unquarantine <udid>` gives it back sooner). Only warden's own devices are quarantined.
- When every device of a run is dropped this way, the run fails with `no device left to run N jobs` instead of passing on nothing.
- `e2e-report.json` `warm[]` entries gain `dropped` and `quarantined`; `axRecovery` can read `rebooted`.
