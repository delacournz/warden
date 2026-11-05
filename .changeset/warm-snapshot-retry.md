---
"@delacour/warden": patch
---

Driver warm-up retries a device's first snapshot with backoff (2 s after the first failure, then 5 s) until the 2 min per-device budget is spent, instead of giving up after one try, and warms devices one after the other instead of all at once. On a loaded host the in-sim bridge can stay silent longer than a single snapshot, which left devices cold and failed each device's first spec; warming several at once made that worse. Each failed try is logged to `warm-<n>.log`.
