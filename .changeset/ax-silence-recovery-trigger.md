---
"@delacour/warden": patch
---

- The iOS helper behind `warden e2e`, `warden ui` and `warden mcp` now restarts a wedged accessibility service even when its in-sim reader reports the timeout itself. A cold reader on a silent service waits out the service's own 10 s query timeout instead of stalling. Those reads failed `E_TIMEOUT` (`did not answer within the query's 10.0s timeout`) without counting towards the restart, so the sim stayed silent until the run ended. They count now, and so do silent reads on an explicit `ax` backend. A count also survives a caller's deadline that ends the read early.
- Before restarting on silence alone (no wedge line in the sim log), the helper reads SpringBoard. If SpringBoard answers, only the foreground app is hung, so nothing is restarted (helper log `an app hang, not an accessibility-server wedge; not restarted`).
