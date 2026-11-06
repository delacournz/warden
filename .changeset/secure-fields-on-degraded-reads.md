---
"@delacour/warden": patch
---

- iOS: a password field (`secureTextEntry`) reads as `securefield` when a read falls back to host `ax`, empty or filled, so `fill` on it no longer fails with "fill did not take" while the accessibility bridge is degraded.
- `fill` on a field that only reads back as bullets confirms the bullet count against the typed length, and its failure message gives the length instead of the typed text.
- On a degraded read, `getByTestId` on a component that wraps its text (a badge around a `Text`) answers `toHaveText` / `text()` from the text its children render instead of failing with "only in the React tree".
