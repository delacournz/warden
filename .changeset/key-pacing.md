---
"@delacour/warden": patch
---

- iOS typing is about 2.6x faster: the default key pacing drops to 5 ms after a key, 20 ms hold and 50 ms before a repeated key, down from 30, 40 and 300 (about 38 ms per character instead of 99 on a local simulator).
- `WARDEN_SIMD_PACE_MS`, `WARDEN_SIMD_HOLD_MS` and `WARDEN_SIMD_REPEAT_GAP_MS` and the `paceMs`, `holdMs` and `repeatGapMs` request fields still override the defaults.
- The typing delays no longer go through the simulator library's timers, so a loaded host (a CI VM) stops stretching them into several times the requested pause.
