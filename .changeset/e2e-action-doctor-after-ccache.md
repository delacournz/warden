---
"@delacour/warden": patch
---

The e2e action runs `warden doctor` after it installs ccache, so a native build cache miss no longer warns that ccache is not on PATH.
