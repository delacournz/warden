---
"@delacour/warden": patch
---

- Fix `warden e2e` on Android failing with "a differently-signed copy ... is installed" on fresh emulators: an Android repack is now signed only with a keystore whose certificate equals the simulator base's signer.
- When no available keystore matches the base's signer, the repack falls back to a full simulator build and names the signers it compared, instead of producing an APK the device rejects.
- Build the Android base once and repacks keep its signer: warden saves the keystore Gradle signed the base with beside the cached APK (owner-only, never logged), so repacks no longer depend on a prebuilt `android/` dir.
