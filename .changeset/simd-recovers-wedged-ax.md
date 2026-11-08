---
"@delacour/warden": minor
---

- `warden-simd` now recovers a simulator whose accessibility service wedged, for every reader (`warden e2e` with or without `--no-warm`, `warden ui`, `warden mcp`, a spec's own reads), not only the warm-up: when one read finds both accessibility readers silent, it checks the sim log for the wedge, confirms with a read that still times out, restarts backboardd once, ends its stale guests and reads on. Reads made meanwhile answer `E_TIMEOUT` with `reason: "ax_wedge_recovering"` (retryable).
- New `WARDEN_SIMD_AX_WEDGE_RESTARTS` (default 1, `0` = never) bounds the restarts per helper; `health` reports `axWedge`, and stall reports carry `axWedge` / `axWedgeRestarts`.
- A spec that failed across such a restart (its app was quit) runs once more.
- The warm-up asks the helper to check instead of restarting backboardd itself; with an older helper it still does it itself.
