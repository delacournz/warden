---
"@delacour/warden": minor
---

- `warden claim --physical` leases a connected physical phone or tablet; `--serial <serial...>` (Android) and `--udid <udid...>` (iOS) name the devices and imply `--physical`. A plain `warden claim` never takes a physical device, even with `--adopt`.
- `--physical` is rejected together with `--count`, `--max`, `--slim`, `--headless`, `--runtime` and `--adopt`, and `--serial` / `--udid` are rejected on the wrong platform.
- A physical device is never booted, created, shut down or slimmed: `warden release --shutdown` and `warden gc` leave it running and say so, and it costs nothing in host capacity.
- Leases and `warden claim --json` carry a `physical` field for real devices.
- The `warden ui` error for an id that is no device now names physical devices.
