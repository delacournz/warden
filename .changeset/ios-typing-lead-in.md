---
"@delacour/warden": patch
---

- iOS `fill`, `type` and `warden ui fill` / `warden ui type` no longer drop or reorder the first letters of the text in a controlled React Native input (`"Hllo"`, `"Hllo, World 123!e"`): the helper now waits 60 ms between the first key and the second, while the field re-renders on its first change
- `WARDEN_SIMD_LEAD_MS` sets that pause (0 turns it off)
