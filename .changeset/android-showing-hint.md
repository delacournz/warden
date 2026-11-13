---
"@delacour/warden": patch
---

- Android: an edit field holding exactly its hint's text now reads as filled, not empty: `warden ui snapshot` prints its `value=`, `get … value` and the spec matchers return the text. The on-device server now says whether a field shows its hint, so an empty field and a filled one are told apart exactly; with no answer (the `uiautomator dump` fallback, an older server) the field still reads as empty when its text equals the hint.
