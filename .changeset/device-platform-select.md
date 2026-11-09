---
"@delacour/warden": minor
---

- Specs: `device.select({ ios, android })` returns the value for the platform under test, like React Native's `Platform.select` (give both platforms or a `default`), so a label or testID that differs per platform stays one line: `screen.getByText(device.select({ ios: "Done", android: "OK" }))`
