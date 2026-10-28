---
"@delacour/warden": minor
---

- `warden ui` on Android keeps one resident host per emulator, which holds the adb shell, `warden-uiad` and animations-off open between calls: `snapshot -i` takes about 90 ms (was 0.6-6 s) and `press` about 120 ms (was about 570 ms). The host starts on the first call and exits after 10 idle minutes, on `warden ui close`, or when the device is released. `warden ui status` shows it as the helper.
- `WARDEN_ANDROID_HOST_IDLE_TIMEOUT` sets the host's idle exit (`2m`-style). `WARDEN_ANDROID_HOST=0` drives the emulator in-process, as before. A host that cannot start falls back to in-process with a note on stderr.
- `warden batch` stops a resident host before it prepares its emulators.
