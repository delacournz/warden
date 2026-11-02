---
"@delacour/warden": minor
---

- `warden run`, `dev`, `batch` and `e2e` now watch the devices they lease: on each 30 s heartbeat a simulator must be Booted in `simctl` and an emulator must answer `adb get-state` with `device`. After two bad reads in a row the device is rebooted under the same lease (waits 5 s, 10 s, 20 s before attempts 1-3, one device at a time) and `warden events` logs `device_unhealthy` and `device_recovered`.
- When all three reboots fail the run stops with exit 11 `LEASE_LOST` naming the dead device.
- Physical devices and devices warden did not create are never rebooted: they only log `device_unhealthy` and warn on stderr, and the run goes on.
- `WARDEN_HEALTH_MONITOR=0` turns the monitor off.
