# WDN-CAM — Simulated camera (image / video asset) for sims + e2e

Plan ID: **WDN-CAM**. Goal: `warden ui camera …` and `device.camera.*` in specs feed a given image or video into the app's real camera stack on iOS sims and Android emulators, so camera screens, photo capture and QR/barcode scanning run unmodified (no app-side bypass).

## Decisions (user, 2026-10-30)
- iOS v1 = full coverage **incl. movie recording** (CAM-9 is in scope, not stretch).
- Android: if in-place swap fails (CAM-0), changing the feed **reboots the lease** with the new flag; exact frames, no virtualscene.
- Spec API **and** suite config key `camera: { back?, front? }` (applied before `app.open`).
- Delivery: commit per phase in sibling worktrees, merge back, **no PR** until asked.

## Mechanisms

| Platform | How | Live swap |
|---|---|---|
| iOS sim (no camera HW, `AVCaptureDevice` returns nil) | extend `libwarden-inject` (`packages/e2e/native/ios-inject/WardenInject.m`, loaded via `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`) with an AVFoundation fake camera fed from the asset | yes, via existing `WARDEN_INJECT_STATE` file (`camera` key) + `.ack` |
| Android emu | emulator flag `-camera-back imagefile:<f>` / `videofile:<f>` (verified in emulator 37.1 `-help-camera-back`); `-camera-front` likewise | spike: replace file in place + re-open camera; fallback `virtualscene` + `adb emu virtualscene-image table <f>`; last resort lease reboot with new flag |
| Physical | — | `E_UNSUPPORTED` |

### iOS coverage (dylib)
- Devices: swizzle `AVCaptureDevice +defaultDeviceWithMediaType:`, `+defaultDeviceWithDeviceType:mediaType:position:`, `+devicesWithMediaType:`, `AVCaptureDeviceDiscoverySession -devices` → fake back/front `WardenCaptureDevice` (runtime subclass; uniqueID, position, formats, `lockForConfiguration` no-op, torch/focus/zoom accept + report).
- Input: `AVCaptureDeviceInput deviceInputWithDevice:error:` / `initWithDevice:` accept the fake; `AVCaptureSession canAddInput/addInput/startRunning/stopRunning/isRunning`.
- Frame pump: one serial queue per running session; image → `CVPixelBuffer` (BGRA, cached), video → `AVAssetReader` loop (`loop` default true), `fps` default 30 (video native). Pump only while a session runs.
- Outputs: `AVCaptureVideoDataOutput` sample-buffer delegate (vision-camera frame processors); `AVCaptureVideoPreviewLayer` contents per frame; `AVCapturePhotoOutput capturePhotoWithSettings:delegate:` → subclass of `AVCapturePhoto` (`fileDataRepresentation`, `pixelBuffer`, `CGImageRepresentation`, `metadata`) with full delegate callback sequence; `AVCaptureMetadataOutput` → `VNDetectBarcodesRequest` on frames → `AVMetadataMachineReadableCodeObject` subclass (type, stringValue, bounds, corners), honours `metadataObjectTypes` + `rectOfInterest`.
- `UIImagePickerController`: `isSourceTypeAvailable:Camera` YES; present w/ camera source → minimal overlay (shutter `testID` `warden-camera-shutter`, cancel `warden-camera-cancel`) → delegate gets `UIImagePickerControllerOriginalImage` (+ `MediaURL` for video mode).
- Permission: TCC stays real (`device.permissions.set({ camera })` / prompt via `alert` API). Mic/audio inputs untouched (out of scope).
- Not covered v1: depth/multi-cam, RAW, ARKit.

### State + assets
- Asset copied to `<lease dir>/camera/<facing>.<ext>` (content-hashed name so the dylib detects change). Types: png/jpg/jpeg/heic (image), mp4/mov/m4v (video); others → `E_CAMERA_MEDIA`.
- State: `{ back?: { path, kind: "image"|"video", loop, fps? }, front?: … }`, persisted in the lease conditions store (`packages/e2e/src/conditions/lease-store.ts`) like network/location so `ui` and specs share it; reset on lease release.
- iOS needs dylib at launch: setting camera while app runs without the dylib → `E_CAMERA_RELAUNCH` hint (same rule as network); `app.open()` loads dylib when camera state present.

## Device rules for spikes/agents
- Devices only from `warden dev <platform> --json` (pid-held, 30 s heartbeat) and only the id it returns. Never bare `warden claim`, never pick from simctl/adb lists, never a self-made AVD or hard-coded serial/port. Stop all device commands the moment a lease ends.

## Spike findings (CAM-0 iOS, CAM-0b Android) — binding for implementation
- iOS (`docs/plans/wdn-cam-0-ios-findings.md`): **shadow session**. Never let the real `AVCaptureSession` connect to the fake device (real `addInput:` hits private Fig/KVO selectors, OS-fragile). Swizzle `AVCaptureDeviceInput deviceInputWithDevice:error:` / `initWithDevice:error:` → `WCInput`, and `AVCaptureSession canAddInput:/addInput:/removeInput:/inputs/startRunning/stopRunning/isRunning`; real `addOutput:` works for all outputs. Swizzle `AVCapturePhotoOutput capturePhotoWithSettings:delegate:` (subclass `AVCapturePhoto` + `AVCaptureResolvedPhotoSettings`), `AVCaptureMetadataOutput setMetadataObjectTypes:/availableMetadataObjectTypes`, `AVCaptureMovieFileOutput start/stop/isRecording` (AVAssetWriter), `connectionWithMediaType:` (fake `AVCaptureConnection initWithInputPorts:@[] output:`), `AVCaptureDevice.RotationCoordinator`. **QR via CIDetector only** (Vision barcode fails on the sim); other symbologies out of scope v1. Preview: set `AVCaptureVideoPreviewLayer.contents` per frame. Picker: own overlay, not Apple's camera UI. expo-camera: two DiscoverySessions (KVO `.devices`), `systemPreferredCamera`, `userPreferredCamera`. Risk: `AVCaptureDeviceFormat`/`activeFormat` (vision-camera).
- Android (`docs/plans/wdn-cam-0-android-findings.md`): file **re-read per camera open** (not per frame); overwrite / tmp+rename / symlink identical; HOME or force-stop + reopen shows the new image. **PNG only** (JPEG at the path renders magenta): re-encode every image to PNG (`sips -s format png` on the macOS host, via injected `Exec`). Any resolution, centre-cropped. No runtime source switch (`emu virtualscene-image` is virtualscene-only). `videofile:` likely needs `-feature VideoPlayback` at boot (untested). `+cam` cold boot ≈ 16 s; argv now has `-no-snapshot-load`.

## Phases

### CAM-0 — 🚧 wip: spikes (blocking CAM-4, informs CAM-2)
- Android: boot leased AVD with `-camera-back imagefile:<f>` from a hot snapshot — does snapshot load still work? does in-place file replace show on next camera open? does `videofile:` need `-feature VideoPlayback`? does golden AVD need `hw.camera.back` ≠ `none`? Record timings.
- iOS: tiny harness (`packages/e2e/native/ios-inject/harness/harness.m`) proving fake `AVCaptureDevice` subclass is accepted by `AVCaptureDeviceInput` + `AVCaptureSession addInput` on sim; `AVCapturePhoto` subclassable.
- Output: `docs/plans/wdn-cam-0-findings.md`. Decide Android live-swap path.

### CAM-1 — ✨ feat: types + driver op
- `packages/core/src/conditions/conditions.types.ts`: `CameraFacing = "back" | "front"`, `CameraFeed = { kind: "image"; path } | { kind: "video"; path; loop: boolean; fps?: number }`, `CameraState = Partial<Record<CameraFacing, CameraFeed>>`.
- `packages/e2e/src/driver/driver.types.ts`: `camera(op: CameraOp): DriverResult<CameraState>`; `CameraOp = { kind: "set"; facing; feed } | { kind: "clear"; facing? } | { kind: "status" }`. Physical drivers → `E_UNSUPPORTED`.
- Media sniff + copy helper `packages/e2e/src/conditions/camera-media.ts` (+ test): ext + magic bytes → kind, errors `E_CAMERA_MEDIA`, `E_CAMERA_NOT_FOUND`.

### CAM-2 — ✨ feat: iOS dylib fake camera
- Extend `WardenInject.m` (new `#pragma mark - camera`), env `WARDEN_CAMERA=1` gates swizzles; feed from state file `camera` key; ack adds `"camera": true`.
- Coverage list above. Harness tests in `harness.m` per surface (device lookup, session/input, data output frames, photo, metadata QR decode, picker).
- Rebuild script under `packages/e2e/native/scripts`; `native` signoff check runs.

### CAM-3 — ✨ feat: iOS driver wiring
- `packages/e2e/src/driver/ios/inject.ts`: add `WARDEN_CAMERA` + state; load dylib when camera state set.
- iOS driver `camera` op writes state, waits for ack (pid/bundle match), timeout → `E_CAMERA_ACK`.

### CAM-4a — ✨ feat: Android `+cam` device identity (prereq for the Android re-spike)
- Why: the emulator's camera source is fixed at boot (`-camera-back imagefile:|videofile:`), released emulators are reused, so a camera emulator must be its own identity, like `+bio` (`packages/core/src/biometrics.ts`).
- `packages/core/src/camera-profile.ts`: `CAMERA_PROFILE_SUFFIX = "+cam"`, `cameraProfile(profile, camera)`, `splitCameraProfile(profile)`; composes with `+bio` in canonical order `<avd>+bio+cam` (callers that split `+bio` must strip `+cam` first).
- Android provider launch of a `+cam` profile: `-camera-back imagefile:<cameraFeedDir(home, serial)>/back.png -camera-front imagefile:<…>/front.png`, both seeded with a neutral grey placeholder PNG before launch (stable paths, so a later in-place swap or reboot reuses them). v0: `+cam` launches **cold boot** (no snapshot, never reports `snapshotFailed` against the base golden) until the re-spike proves snapshot loads.
- CLI: `--camera` on the claim option sets (`claim`, `run`, `dev`), mapped through `cameraProfile`; iOS ignores it (identity unchanged: the dylib needs no device variant). Skill sync + help snapshots.
- Non-goals here: swapping feeds, undo, e2e config (CAM-4/5).

### CAM-0b — 🚧 wip: Android re-spike on `warden dev android --camera`
- Only via `warden dev android --camera --json` (pid-held lease) and the serial it returns; never a self-made AVD, hard-coded serial or console port. Questions: exact frames; in-place replace / rename / symlink swap seen on camera reopen; `videofile:` loop; image↔video mode change needs reboot; does a `+cam` launch load the base golden snapshot.

### CAM-4 — ✨ feat: Android emulator camera op
- Only `+cam` emulators (CAM-4a): `camera` op on a plain emulator → `E_CAMERA_DEVICE` "claim with --camera" (error code added to `DriverErrorCode`).
- Image feed: re-encode to PNG into a temp file in `cameraFeedDir`, rename over `<facing>.png`; result `appliesOnCameraOpen: true`, `rebooted: false`. `null` / a facing left out → grey placeholder.
- Video feed (or image→video / video→image): per-device camera mode recorded in `<cameraFeedDir>/mode.json`; the provider's `+cam` launch reads it (`-feature VideoPlayback -camera-back videofile:<dir>/back.<ext>` vs `imagefile:`); the driver restarts the leased emulator through the provider (same serial, lease kept), waits ready, returns `rebooted: true`. Verify on a `warden dev android --camera` lease (device rules) that `videofile:` plays and loops.
- Release / undo (`packages/core/src/conditions/undo.ts` camera case): feeds back to placeholder; a device in video mode is shut down on release (it is warden-created) so the next claim boots in image mode.

### CAM-5 — ✨ feat: spec API
- `packages/e2e/src/device.ts`: `device.camera: DeviceCamera` = `set(path, { facing?: "back"|"front"|"both", loop?, fps? })`, `clear(facing?)`, `status()`; auto-clear at test end (like `location`). Path resolved relative to spec file.
- Suite config `camera: { back?: string | CameraFeedInput, front?: … }` in `warden.config.ts` (paths relative to config), applied before first `app.open()`; config schema + `conditions.config.test.ts`.
- Tests in `device.test.ts`, `session.test.ts`.

### CAM-6 — ✨ feat: `warden ui camera`
- `apps/cli/src/agent-ui/camera-register.ts` (pattern: `network-register.ts`): `warden ui camera set <path> [--facing back|front|both] [--no-loop] [--fps <n>]`, `warden ui camera status`, `warden ui camera clear [--facing …]`; `--json`. Register from `commands/ui.ts`; help snapshot update; `warden mcp` tool if conditions are exposed there.

### CAM-7 — ✅ test: example app + e2e suite
- `apps/example`: Camera screen (expo-camera preview + take photo + QR scan result text with testIDs) and image-picker camera button.
- Fixtures: `apps/example/e2e/fixtures/camera/{qr-hello.png,scene.mp4}`.
- `camera.e2e.ts`: preview shows frame, photo matches (pixel hash), QR decodes `hello`, live swap to second QR, front/back, clear → no device. Run iOS + Android via `warden e2e example`.

### CAM-8 — 📝 docs: skill + docs + changeset
- `skills/warden/references/ui.md` (`warden ui camera`), `specs.md` (`device.camera`), `troubleshooting.md` new entries appended (E_CAMERA_*), SKILL.md quick ref line; `apps/docs/content/docs` page; `.changeset/camera-simulation.md` `minor`.
- Verify: `cd apps/cli && bun test src/skill-coverage.test.ts src/skill.test.ts`.

### CAM-9 — ✨ feat: iOS movie recording
- `AVCaptureMovieFileOutput` → `AVAssetWriter` from pumped frames.

## Parallelism
CAM-0 first. Then CAM-1 → {CAM-2+3, CAM-4, CAM-6 (against types)} in parallel worktrees; CAM-5 after CAM-1; CAM-9 after CAM-2; CAM-7/8 last.
