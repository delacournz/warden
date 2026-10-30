---
"@delacour/warden": minor
---

- Add `warden ui biometrics [status|enroll|unenroll|match|fail]`: simulated Face ID, Touch ID and Android fingerprint on warden-claimed simulators and emulators. Answers `{ enrolled, modality }`; a physical device or an Android `enroll` / `unenroll` fails with `E_UNSUPPORTED`.
- Add `device.biometrics.status()`, `enroll()`, `unenroll()`, `match()` and `fail()` to `@delacour/warden-e2e` specs (`BiometricState`, `DeviceBiometrics` types). Android `enroll` / `unenroll` throw `ACTION_FAILED`.
- Add the `biometrics` config key (top level, `e2e.<suite>`, `batches.<preset>`; default `false`) and the `--biometrics` flag on `claim`, `run`, `batch` and `e2e`. Devices get the profile `<profile>+bio`, with their own pool and golden snapshot.
- Android `+bio` devices start from a golden snapshot with a fingerprint already enrolled (screen-lock PIN `1111`); `warden golden ensure --platform android --profile <profile>+bio` builds it ahead of the first claim.
- iOS `+bio` simulators are enrolled on every boot and again when a spec process starts, before the app is installed.
- Android `+bio` golden snapshots are saved past the lock screen with the screen kept on; a claim returns once adb, the package manager and the unlocked screen answer, unlocking with the PIN if needed, and an emulator that never gets ready is shut down instead of left locked.
- `warden ui reload` / `eval` / `logs` and the other devtools verbs find a dev client on a `+bio` simulator (Metro reports the `+` in its name as a space).
