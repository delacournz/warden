---
"@delacour/warden": minor
---

- `warden claim --idempotency-key <key>` (or `WARDEN_IDEMPOTENCY_KEY`) makes a claim safe to repeat: the same owner repeating the key while the leases are alive gets the same lease JSON back instead of a new device. A different request under a live key fails with a usage error; the key is free again once the leases are released.
