---
"@delacour/warden": minor
---

- iOS e2e and `warden ui`: when the simulator's accessibility bridge stops answering, a `snapshot` no longer times out after 10 s with `E_TIMEOUT`. The read moves to the host accessibility reader after 4 s, the next reads go straight there, and the bridge is asked again 20 s later. Seen on GitHub-hosted `macos-26` runners, where every spec failed `did not become visible` and the warm-up logged `not warm: snapshot failed: E_TIMEOUT`.
- New `WARDEN_SIMD_BRIDGE_DEADLINE_MS` (default 4000, `0` turns the deadline off) and `WARDEN_SIMD_BRIDGE_COOLDOWN_S` (default 20, `0` never skips the bridge) tune it.
- The `driver.snapshot` span in `trace.jsonl` now carries `backend` and `fallback` when a read did not come from the bridge, so a CI run shows why.
