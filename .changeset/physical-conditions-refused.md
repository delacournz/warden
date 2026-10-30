---
"@delacour/warden": patch
---

- Device conditions and settings (`warden ui network|location|clock|permission|timezone|locale|a11y|battery|memory-warning|push`, `device.network`, `device.location`, `device.clock` and the other spec condition APIs) fail with `E_UNSUPPORTED` on a physical iPhone or Android phone, before anything reaches the phone: warden never flips a phone's airplane mode, clock, timezone or font scale.
- An `e2e` suite that sets both `physical` and `conditions` is refused when `warden.config.ts` loads.
