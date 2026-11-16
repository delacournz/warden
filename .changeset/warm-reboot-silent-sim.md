---
"@delacour/warden": patch
---

- `warden e2e` on iOS now recovers a simulator whose accessibility service never answers even when its log does not show the wedge. On some CI hosts `log show` cannot read the simulator runtime's messages (every system line is `<compose failure>`), so the backboardd restart never ran and every spec on that sim failed with `E_TIMEOUT` (`did not answer within the query's 10.0s timeout`). The warm-up now reboots the sim once after 3 snapshots in a row time out over at least 60 s (warm log `rebooting <udid>: 3 snapshots in a row timed out over N s, with no wedge found in the sim log`).
- A device whose warm-up hits its deadline keeps its last read error and recovery record (`warm[].error` `timed out after 120s; last: E_TIMEOUT: …`, `warm[].axRecovery`), so a sim that is still silent after its reboot is dropped and quarantined instead of running specs that can only time out.
