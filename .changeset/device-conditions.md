---
"@delacour/warden": minor
---

- Device conditions set on a lease (network, location, clock, …) are always undone when the lease is released or garbage-collected.
- Android emulators can be set offline (airplane mode, checked against the device's connectivity state) or shaped to the `edge`, `3g`, `4g`, `lte`, `wifi`, `slow` and `lossy` network presets.
