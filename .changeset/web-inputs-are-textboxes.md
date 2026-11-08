---
"@delacour/warden": patch
---

- iOS: a text input in a web view (Safari, a `WKWebView`) reads as `textbox` instead of `other`, and a `type=password` input as a secure `textbox`, empty, focused or filled, so `getByRole("textbox")`, `fill` and `warden ui fill role=textbox …` reach web form fields.
