---
"@delacour/warden": minor
---

- Local native builds (`warden builds`, `warden e2e`, `warden dev`) now time out after 90 min instead of 60 min, so a cold Expo iOS build on a small hosted Mac runner finishes instead of being stopped with exit 143.
- iOS local builds key ccache on the selected Xcode's version and build (`CCACHE_COMPILERCHECK=string:xcode-<version>-<build>`) instead of the compiler's modification time, so a CI image that reinstalls the same Xcode still hits the restored `~/.warden/ccache`. A `CCACHE_COMPILERCHECK` you set yourself is kept.
