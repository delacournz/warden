---
"@delacour/warden": minor
---

- iOS Simulators driven by warden (`warden e2e`, `warden ui`) have autocorrect, predictive text and spell check turned off, so text a spec types reads back as typed: a fresh simulator could autocorrect `Buy` + ` milk` to `But milk`. Autocapitalization is left on.
