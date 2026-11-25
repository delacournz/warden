---
"@delacour/warden": minor
---

- `warden claim ios|android --host <name>` claims a device on a warden host over ssh: the host allocates, queues and boots, and the laptop records a lease per device. `--profile`, `--runtime`, `--count`, `--max`, `--wait`, `--priority`, `--label`, `--ttl` and `--idempotency-key` work as for a local claim; the host's claim errors keep their codes and exit codes.
- An unreachable host is retried three times with the same idempotency key, so a claim is never made twice.
- The host's lease is short (`WARDEN_REMOTE_TTL`, default `90s`) and renewed every 30 s in the background while the local lease lives; a laptop that goes away frees the host's device within that TTL.
- `warden heartbeat` and `warden release [--shutdown]` are passed on to the host. `warden ls` shows a `HOST` column, `warden ls --hosts` lists only host leases, and `warden check` knows them. `warden host rm` refuses while a host backs leases.
- A host lease that ends without a release is a `host_lost` event (`unreachable`, `remote_gone` or `host_expired`); a run holding it stops with `LEASE_LOST`. A hosted Mac's session end caps the lease, with a heartbeat warning 10 minutes before.
