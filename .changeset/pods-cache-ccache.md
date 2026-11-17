---
"@delacour/warden": patch
---

- iOS local builds (`warden builds`, `warden e2e`, `warden dev`) use ccache again when the pods cache installs pods. warden's own `pod install` now runs with `USE_CCACHE=1` and the rest of the compiler-cache env, so React Native wires its ccache compiler wrapper into the Pods project. Before, a cold native build compiled every file with plain clang and `~/.warden/ccache` got no new entries.
- Pods cached without ccache no longer restore: `USE_CCACHE` is part of the pods cache key, so the next build runs a real `pod install` once.
