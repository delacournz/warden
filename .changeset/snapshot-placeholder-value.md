---
"@delacour/warden": patch
---

- `warden ui snapshot` no longer reports an empty text field's placeholder as its value: iOS and Android show the placeholder (iOS) or hint (Android) as an empty field's value, which read as filled. Text inputs now print `placeholder="…"` (and `placeholder` in `--json`), and `value=` only when the field holds something else.
- `warden ui get … value`, `wait text`, `text=` / `value=` selectors and the spec matchers `toHaveValue` / `toHaveText` read a field showing its placeholder as empty. A field holding exactly its placeholder's text reads the same (the platforms report it identically); `fill` with that text still confirms.
- iOS: React Native inputs now carry their placeholder on the default accessibility reader too (it left them out), so `getByPlaceholder` finds them. Each field costs one extra lookup (~10 ms) the first time it is seen.
