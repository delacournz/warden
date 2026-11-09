---
"@delacour/warden": patch
---

- `locator.clear()` no longer fails with `ACTION_FAILED` on an iOS React Native text field that has a placeholder: an emptied field reads back as its placeholder there, and `clear()` now counts a value that deleting could not have left (not made of the cleared text's characters, in order) as empty, and a field that was already empty is told apart from one holding its placeholder's text by typing one key (deleted again)
