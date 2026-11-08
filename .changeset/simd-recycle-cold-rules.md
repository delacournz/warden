---
"@delacour/warden": minor
---

- iOS: an accessibility bridge guest replaced after a stall now starts like a fresh one: its first read gets the cold deadline, its first stall no longer starts the 20 s cooldown, and the helper warms it in the background, going back to the bridge as soon as it answers.
- New `WARDEN_SIMD_BRIDGE_MAX_RECYCLES` sets how many stalled guests one `warden-simd` helper may replace (default 3; `0` never replaces one; an invalid value keeps the default and logs a warning).
