---
"@delacour/warden": minor
---

- `warden claim --physical` leases a connected physical phone or tablet; `--serial <serial...>` (Android) and `--udid <udid...>` (iOS) name the devices and imply `--physical`. A plain `warden claim` never takes a physical device, even with `--adopt`.
- `--physical` is rejected together with `--count`, `--max`, `--slim`, `--headless`, `--runtime` and `--adopt`, and `--serial` / `--udid` are rejected on the wrong platform.
- A physical device is never booted, created, shut down or slimmed: `warden release --shutdown` and `warden gc` leave it running and say so, and it costs nothing in host capacity.
- Leases and `warden claim --json` carry a `physical` field for real devices.
- The `warden ui` error for an id that is no device now names physical devices.
- `warden ui` drives Android phones: `--serial <adb serial>` (USB, `ip:port` or wireless-debugging serials) leases the phone as physical, and `warden ui --claim --physical` claims a connected one. `warden devices` marks phones `physical` and `warden ls` tags their leases.
- `warden ui` exits 2 with `device_unauthorized` (accept the USB debugging prompt) or `device_offline` for a phone adb cannot drive yet; the lease is kept.
- A device whose qemu properties are set (`localhost:5555`, Genymotion) is treated as a foreign emulator, never as a phone.
- On a phone warden wakes the screen and dismisses a keyguard with no credential; a PIN, pattern or password lock fails `E_DEVICE_LOCKED` and warden never unlocks it. Rotation, dark mode and animation scales are saved before the first change and restored on close.
- `uninstall` and `clear data` on a phone refuse any package warden did not install (`E_REFUSED`, `physical_protected`).
- Installing an APK on a phone checks its native ABIs first and fails `abi_mismatch` with a hint to use the `dev` or `release` build kind; `INSTALL_FAILED_UPDATE_INCOMPATIBLE` says to uninstall the differently-signed copy yourself, and warden never does it for you.
- Device sockets and state directories no longer collide for wireless-debugging serials.
