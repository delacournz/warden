---
"@delacour/warden": patch
---

A simulator repack is now valid only for the base it was cloned from. After `warden builds import --kind simulator-base` replaces the base under the same native fingerprint (a CI build with another signature or entitlements), `warden repack` and `warden e2e` repack instead of installing a repack of the old base. `warden repack --json` reports `reason: "base-changed"` when it does, and devices reinstall the new repack. A repack made by an older warden is rebuilt once (`reason: "base-unrecorded"`).
