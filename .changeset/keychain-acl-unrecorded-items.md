---
"@delacour/warden": patch
---

- Keychain ACL shim: a `.biometryCurrentSet` item the app wrote while the shim was off (a suite with `keychainAcl: false`, `warden dev` without `--keychain-acl`) no longer reads `-25300` on a simulator that was re-enrolled in an earlier lease. The shim records such an item the first time it reads it, so only a `reenroll` after that invalidates it.
