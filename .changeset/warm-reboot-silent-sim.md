---
"@delacour/warden": patch
---

- `warden e2e` on iOS now recovers a simulator whose accessibility service never answers even when its log does not show the wedge. On some CI hosts `log show` cannot read the simulator runtime's messages (every system line is `<compose failure>`), so the backboardd restart never ran and every spec on that sim failed with `E_TIMEOUT` (`did not answer within the query's 10.0s timeout`). Once 3 snapshots in a row time out over at least 60 s, the warm-up now restarts backboardd through the helper (below). When that cannot run or does not clear it, the warm-up reboots the sim once (warm log `rebooting <udid>: …`).
- The iOS helper behind `warden e2e`, `warden ui` and `warden mcp` restarts a wedged accessibility service mid-run on such hosts too: when the sim log names no wedge or cannot be read, both readers silent on 3 reads in a row over at least 60 s (no read answering in between) stands in for it, still confirmed by one more read that times out (helper log `the sim log names no wedge, but both readers silent on 3 reads in a row over N s`).
- A device whose warm-up hits its deadline keeps its last read error and recovery record (`warm[].error` `timed out after 120s; last: E_TIMEOUT: …`, `warm[].axRecovery`), so a sim that is still silent after its reboot is dropped and quarantined instead of running specs that can only time out.
