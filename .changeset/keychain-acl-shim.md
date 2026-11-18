---
"@delacour/warden": minor
---

- iOS simulator apps can have Keychain items behind access control (`.biometryCurrentSet`, `.biometryAny`, `.devicePasscode`, `.userPresence`, `.or`) behave like they do on a device: with the Keychain ACL shim on, reading such an item shows the real Face ID / Touch ID or passcode sheet, driven by `warden ui biometrics match|fail`, and answers the code a device is expected to give (cancel `-128`, no UI allowed `-25308`, biometry unusable for a biometry-only item `-25300`). It emulates the prompt and the codes; real enforcement is still verified on a physical device.
