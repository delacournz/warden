---
"@delacour/warden": patch
---

`warden e2e`, `warden ui` and the specs find the `warden-simd` that `warden doctor --fetch-helper` staged under `$WARDEN_HOME/simd/<version>`. Before, a release binary with the helper fetched there (not next to it) failed every run with `E_HELPER_MISSING: warden-simd not found`.
- A native fingerprint command that exits cleanly but prints nothing now reports its stderr and command in the error, not `(empty)` alone.
- Spec processes only get `WARDEN_HELPER_DIR` when `warden-simd` is in that directory. A directory without it (a release binary whose helper `doctor --fetch-helper` staged under `$WARDEN_HOME`, a checkout that never built it) made every spec fail with `E_HELPER_MISSING` instead of falling through to the staged copy.
