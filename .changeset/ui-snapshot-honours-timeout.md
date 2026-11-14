---
"@delacour/warden": patch
---

- `warden ui snapshot` and `warden ui find` on iOS stop at `--timeout` (default 5000 ms) when the simulator's accessibility bridge does not answer. Before, each call waited up to 60 s for the bridge and then failed, whatever `--timeout` said.
- A timed-out `snapshot` or `find` now prints a hint: a cold simulator can need `--timeout 60000`.
