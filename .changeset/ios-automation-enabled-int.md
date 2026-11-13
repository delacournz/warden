---
"@delacour/warden": patch
---

- iOS: every `warden ui` command and every spec's driver open is ~0.35 s faster. The simulator stores the accessibility `AutomationEnabled` flag as `1`, which was not read as on, so the in-simulator write ran again on every call (`warden ui snapshot -i` 0.5-0.7 s → 0.14-0.17 s)
- A golden simulator image holding that flag as `1` is no longer rebuilt, and an imported golden archive holding it is no longer skipped
