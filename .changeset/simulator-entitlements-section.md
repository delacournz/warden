---
"@delacour/warden": patch
---

- `warden builds import --kind simulator-base` no longer warns about a missing `application-identifier` on an ad-hoc signed simulator build (`CODE_SIGN_IDENTITY=-`). Such a build signs with no entitlements and links them into the executable's `__TEXT,__entitlements` section, which is what the simulator reads; the check now reads that section too (`otool`), so `applicationIdentifier` in `--json` is `true` for it.
