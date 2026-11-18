---
"@delacour/warden": patch
---

- `warden e2e` warm-up no longer restarts its count of timed-out reads when the simulator helper refuses a frontmost lookup under its backoff (`E_AX_UNAVAILABLE … the frontmost lookup failed recently`). That refusal asks nothing of the simulator, so an iOS simulator whose accessibility service stays silent and whose sim log names no wedge is now rebooted once, as intended, instead of starting the suite cold on a stalled bridge.
