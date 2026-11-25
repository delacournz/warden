---
"@delacour/warden": minor
---

- `warden dev` dashboard: `C` opens a conditions menu. Pick an area, then a preset: biometrics (enroll, match, fail, unenroll, reenroll), location scenarios, appearance, keyboard, accessibility and battery, plus network (offline, edge, 3g, lte, slow, lossy, flap, reset) and clock (advance, reset) on Android. Each preset runs the matching `warden ui` command on the session's device. Presets run one at a time in the order picked, in one shared row.
