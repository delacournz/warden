---
"@delacour/warden": minor
---

- Simulated camera for iOS simulators and Android emulators: feed a png, jpg, heic, mp4 or mov into the app's real camera for preview, photo capture, video recording and QR / barcode scanning.
- `warden claim android --camera` / `warden dev android --camera`: an emulator whose back and front cameras are fed from files.
- `device.camera.set(path, { facing, loop })`, `clear(facing)` and `status()` in specs: the path is relative to the spec file, the camera is taken off when the test ends, and the result says whether the feed applies on the app's next launch, its next camera open, or after the emulator rebooted. Missing or unsupported files fail with `E_CAMERA_NOT_FOUND` / `E_CAMERA_MEDIA`, an Android emulator without `--camera` with `E_CAMERA_DEVICE`.
- Suite `camera: { back?, front? }` in `warden.config.ts` (a path or `{ path, loop }`, relative to the config file): fed before each spec's first `app.open()`, and the suite's Android devices are claimed with `--camera`.
- `warden ui camera set <path> [--facing back|front|both] [--no-loop]`, `camera status` and `camera clear [--facing …]`: drive the same camera by hand, undone when the lease is released.
