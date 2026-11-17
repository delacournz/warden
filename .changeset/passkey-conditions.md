---
"@delacour/warden": minor
---

- New simulated passkeys: warden's virtual authenticator answers an app's real passkey create and sign-in calls with test keys, on a leased iOS Simulator or an Android emulator (API 34+), with no iCloud or Google account. Modes `auto`, `cancel`, `fail`, `unavailable`; user verification `match`, `nomatch`, `skip`. Attestation `none`, ES256 keys.
- New `warden ui passkey set|off|add|list|remove|clear|status`. The authenticator and its credentials belong to the lease and are removed on release; on Android the previous credential provider is put back.
- New `device.passkeys` in specs (`set`, `off`, `add`, `list`, `remove`, `clear`, `status`): mode and user verification go back at the end of each test, credentials stay for the lease.
- New `conditions.passkeys` suite key: a mode, or `{ mode, uv, credentials }` seeded before the first `app.open()`.
- New error codes `E_PASSKEY_API` (Android below API 34) and `E_PASSKEY_STORE` (the credential store does not read). Physical devices answer `E_UNSUPPORTED`.
