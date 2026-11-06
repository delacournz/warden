---
"@delacour/warden": minor
---

- iOS: the first accessibility read after the helper starts, a guest is recycled or an app launches gets a 12 s bridge deadline instead of 4 s, and a stall on it no longer sends the next 20 s of reads to the host `ax` reader (which drops testIDs on static text); a second stall on the same cold guest still does
- iOS: `warden-simd` warms its bridge in the background at start and after each launch, and a read that arrives meanwhile waits for that read instead of starting a second slow one
- iOS: the driver waits 20 s for a read while the bridge is cold, so it no longer times out before the helper's own deadline
- New `WARDEN_SIMD_BRIDGE_COLD_DEADLINE_MS` (default 12000) sets the cold deadline; the driver's cold-read timeout follows it
