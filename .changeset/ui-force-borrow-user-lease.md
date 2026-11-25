---
"@delacour/warden": minor
---

- `warden ui … --force` now also drives a device you hold from another shell (a `warden claim` or `warden dev` in another terminal): the lease is borrowed as is, `--json` carries `attachedTo`, and `close --release` keeps it. An agent's or CI's lease is still `device_foreign`.
- The `device_foreign` error for a lease you hold from another shell hints at `--force` or `warden release <leaseId>`.
