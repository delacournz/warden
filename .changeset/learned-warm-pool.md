---
"@delacour/warden": minor
---

- `WARDEN_WARM=1` (off by default) keeps a learned warm pool: `warden gc` boots existing slim, idle warden devices up to the 24 h peak of concurrent leases per platform and profile, queue head's profile first. It acts only at memory pressure `normal`, stays inside the capacity budget, and never creates, or touches foreign, golden, quarantined or physical devices.
- Warm devices skip the 20 min idle shutdown, and a queued claim evicts them only after every other idle device.
- `warden capacity` shows the warm pool (`warm.enabled`, `warm.rows` with target, actual and peak per platform and profile in `--json`).
- Background gc now runs every interval while `WARDEN_WARM=1`.
