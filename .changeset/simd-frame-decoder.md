---
"@delacour/warden": minor
---

- `warden-simd` links idb with a single-pass bridge frame decoder: the helper's CPU per accessibility read drops by about three quarters (host 9.12 → 3.79 CPU-seconds per bench rep on EAS `macos-large`), memory unchanged.
- `WARDEN_SIMD_TIMEOUT` (a duration, e.g. `60s`) sets the per-request timeout of the helper client `warden ui` and the e2e runner connect with; the default stays 10 s.
- `warden e2e` / `warden dev` honour the core `eas: false` opt-out and never call eas-cli when it is set.
- Golden settle probe works without a GUI launchd session (hosted workers, ssh).
