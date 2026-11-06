---
"@delacour/warden": minor
---

- `warden golden export --allow-unsettled` exports a golden whose first boot never settled (`"unsettled": true` in `--json`), so a CI runner too small to settle one caches it instead of building it on every run. Without the flag the refusal now names it.
- A simulator base, repack, dev or release build whose files a CI cache restored without `warden.db` is registered on first use (`"source": "restored"` in `warden builds --json`) instead of being rebuilt.
- Builds are moved into the cache from a staging dir, so an interrupted copy never leaves a half-written build behind.
