---
"@delacour/warden": patch
---

- `warden claim` / `warden dev` no longer queue forever on macOS when the kernel reports memory pressure `warn` while plenty of memory is free: a kernel `warn` now holds the boot queue only when `memory_pressure` also shows under 25% free (`critical` still always holds). `warden capacity` shows the same reading.
- `warden dev`'s dashboard shows the claim's progress under the claim row (`queued #1 of 1 (high) — memory pressure warn` and similar), instead of sitting on "preparing the ios dev build" with no output.
