---
"@delacour/warden": minor
---

Host-spec limits are now off by default (changed default, hence minor): a claim boots the devices it asks for, with no RAM/CPU budget, no boot queue, no memory-pressure hold, and a `--max` that is not given no longer defaults to cores / 4 (the pool is uncapped). Opt back in with `WARDEN_CAPACITY=on` (`1` / `true` / `yes`); then the budget, queue and defaulted `--max` work as before. A `--max` you pass or set in config always holds. In CI (`CI=true` / `1` or `GITHUB_ACTIONS=true`) the RAM headroom defaults to 0 when limits are on, so a 7 GB runner no longer ends up with a 0 MB budget; `WARDEN_CAPACITY_HEADROOM_GB` still wins. `WARDEN_CAPACITY=off` is still accepted and is the default. `warden capacity` and `warden queue` still show the numbers and now say whether limits are enforced (`enforced` in `--json`; `capacity --json` keeps `enabled` as the same value). The `WARDEN_WARM=1` warm pool is no longer capped by the host budget unless limits are on.
