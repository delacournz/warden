---
"@delacour/warden": patch
---

- `warden e2e --dev` on Android points the dev client at warden's Metro on every `app.open()`, with the onboarding sheet and dev menu off, instead of launching it on its default url
