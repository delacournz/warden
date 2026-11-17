---
"@delacour/warden": patch
---

- `warden pods install` now installs pods with the same env as warden's iOS builds (`USE_CCACHE=1`, the ccache vars and the prebuilt React Native `RCT_*` vars; no ccache vars when `build.cache: false`). Running it before `warden dev`, `warden app ensure` or `warden e2e` now leaves their pods up to date instead of triggering a second full `pod install`.
