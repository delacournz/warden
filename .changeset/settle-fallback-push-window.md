---
"@delacour/warden": patch
---

- iOS `device.settle()` fallbacks (`via: "snapshot"` and `via: "hash"`) now wait for at least 500 ms of unchanged screen, whatever `quietMs` asks: a navigation push shows both screens at their final frames for 300-460 ms, and the old 250 ms window could settle on that mixed tree.
