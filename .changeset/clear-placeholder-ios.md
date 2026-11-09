---
"@delacour/warden": patch
---

- `locator.clear()` no longer fails with `ACTION_FAILED` on an iOS React Native text field that has a placeholder: an emptied field reads back as its placeholder there, and `clear()` now counts a value that deleting could not have left (not made of the cleared text's characters, in order) as empty
