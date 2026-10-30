---
"@delacour/warden": patch
---

- `device.alert` on iOS answers `true` only once the alert is gone: a press that lands while the sheet is still animating in (LocalAuthentication's "Face Not Recognized") is pressed again, and an alert that survives three presses throws `ACTION_FAILED` instead of reporting it answered.
