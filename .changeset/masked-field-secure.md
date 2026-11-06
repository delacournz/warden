---
"@delacour/warden-e2e": patch
---

- `fill` no longer fails on a secure field the iOS accessibility tree reports as a plain text field: a text field whose value is only mask bullets counts as secure, so it is not read back and compared.
