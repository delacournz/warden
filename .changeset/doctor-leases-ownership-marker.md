---
"@delacour/warden": minor
---

- `warden doctor --leases [--fix] [--json]` checks the lease registry against the machine: a lease on a device that is gone, a booted warden sim nothing tracks, a stale `pending:` placeholder, a queue row with a dead pid, a recorded sim missing from disk, an ownership-marker mismatch, plus stale idempotency keys and orphaned reclaim retry state. Exit 0 when clean, 1 when drift remains; `--fix` deletes only registry rows and never shuts down, erases or deletes a device.
- Every iOS simulator warden creates now carries a `.warden-owned.json` ownership marker with this warden home's instance id. Shutdown on release, health-monitor reboots, reclaim `erase` / `uninstall`, `warden sims prune` and `warden sims delete` leave a sim whose marker names another warden instance alone; sims without a marker behave as before.
