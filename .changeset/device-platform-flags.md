---
"@delacour/warden": minor
---

- Specs: `device.os` (`"ios"` | `"android"`), `device.isIOS` and `device.isAndroid` name the platform under test, like React Native's `Platform.OS`, so a step only one platform needs can sit behind an `if` (and helpers that only get `device` can branch too)
