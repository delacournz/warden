---
"@delacour/warden": patch
---

- Keychain ACL shim: a lease that expired or was taken back without a release (a crashed `warden ui` session, an evicted claim) no longer leaves the shim on for the next holder. Every claim of an iOS simulator now switches it off before handing the device out, so a later `warden ui open` without `--keychain-acl`, or a suite with no `keychainAcl` key, gets no Face ID prompts it never asked for.
