---
"@delacour/warden": minor
---

- `warden ui` drives a device claimed with `warden claim --host`: `open`, `snapshot`, `find`, `get`, `is`, `wait`, `press`, `tap`, `fill`, `type`, `key`, `scroll`, `gesture` and `close` run against the host's warden over ssh. Other verbs exit 1 with `does not drive a host's device`; `close --release` releases the lease on the host too.
- `@delacour/warden-e2e` connects to a host's device when `WARDEN_HOST` and `WARDEN_HOST_DRIVER` (JSON argv that serves the device's driver) are set.
