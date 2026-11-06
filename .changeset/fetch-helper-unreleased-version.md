---
"@delacour/warden": patch
---

- `warden doctor --fetch-helper` downloads nothing when a `warden-simd` the driver picks first is already there (`WARDEN_SIMD`, `WARDEN_HELPER_DIR`, one next to the binary, a source build), and says where; `--json` reports `helperFetch.status` `present` or `fetched`.
- Run from a checkout whose version has no release yet (a version-bump branch), `warden doctor --fetch-helper` takes the latest release's helper with a warning instead of failing on a missing `SHA256SUMS`.
