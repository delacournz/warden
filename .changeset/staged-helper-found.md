---
"@delacour/warden": patch
---

`warden e2e`, `warden ui` and the specs find the `warden-simd` that `warden doctor --fetch-helper` staged under `$WARDEN_HOME/simd/<version>`. Before, a release binary with the helper fetched there (not next to it) failed every run with `E_HELPER_MISSING: warden-simd not found`.
