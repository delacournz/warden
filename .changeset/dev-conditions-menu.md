---
"@delacour/warden": minor
---

- `warden dev` dashboard: `C` opens a conditions menu. Pick an area, then a preset: biometrics (enroll, match, fail, unenroll, reenroll), network (offline, edge, 3g, lte, slow, lossy, flap, reset), location scenarios, clock advance and reset, appearance, keyboard, accessibility and battery. Each preset runs the matching `warden ui` command on the session's device, in its own row.
