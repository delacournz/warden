# WDN-CAM CAM-0b: Android re-spike findings

Device: `warden dev android --camera --json` from this checkout (HEAD 16aa326b) -> `warden-pixel-10+cam-1`, `emulator-5554`, leases `l_905958e0c343` (device) + `l_7a084286ff04` (port). Emulator 37.1.11.0, Android 17, Pixel_10 AVD. Stock camera `com.android.camera2`. Dev process was SIGINTed at the end; warden shut the emulator down and the leases are gone (`warden ls` shows no lease of this session).

## Launch evidence
- Argv (ps): `qemu-system-aarch64-headless -avd Pixel_10 -port 5554 -no-window -read-only -no-snapshot-save -no-boot-anim -no-audio -no-metrics -camera-back imagefile:/Users/chris/.warden/camera/emulator-5554/back.png -camera-front imagefile:/Users/chris/.warden/camera/emulator-5554/front.png`.
- Paths = `cameraFeedDir(home, serial)`. The emulator log (`~/.warden/logs/emulator-5554.log`) has NO "Initialized camera with name: imagefile|..." line at default verbosity (would need `-verbose`/`-debug camera`); confirm paths from argv instead. The log file is shared by every run of that serial (append), read only the tail of the latest run.
- Base AVD `Pixel_10` `config.ini`: `hw.camera.back=virtualscene`, `hw.camera.front=emulated`. The `-camera-*` flags override it; no golden change was needed for `imagefile:`.
- Camera service lists 2 devices: id 10 = back, id 11 = front (`dumpsys media.camera`).
- Placeholders: 64x48 8-bit gray PNG, value 128.

## Q1 Placeholder exact?
Yes, both facings. Preview region mean = 49.79% gray (= 127/128) on back (id 10, screenshot `s1_default_back.png`) and front (id 11, `s1_front_orig_grey.png`). Preview is 1080x1440 (3:4 portrait) inside 1080x2424.
Front: `IMAGE_CAPTURE` extras (`CAMERA_FACING`, `USE_FRONT_CAMERA`) do NOT select the front camera; switch via UI Options (content-desc "Options" -> "Back camera"/"Front camera" toggle). camera2 then remembers the facing across force-stop.

## Q2 Live swap (mean RGB of preview region checked per step)
Image is read on **camera device open** (HAL open), not per frame and not only at boot.

| swap | while camera open (3-6 s) | after force-stop + reopen |
|---|---|---|
| (a) in-place overwrite (`cp`, same inode) | unchanged (still gray) | new image |
| (b) temp file + `mv` over back.png | unchanged | new image |
| (c) back.png replaced by symlink to another file | unchanged | new image (followed) |
| overwrite while app backgrounded (HOME), relaunch WITHOUT force-stop | n/a | new image (HOME closes the camera device: `Active Camera Clients: []`; reopen re-reads) |

- Front.png swap behaves the same (swapped then reopened -> new image, `s1_front_swapped2.png`).
- Nothing was cached by path/size/mtime: each open re-read the file.
- Implication: an app that keeps the camera open (a live preview screen) will NOT show the new image until it closes and reopens the camera device (navigate away/back, background, or process restart). The emulator offers no signal to force this.

## Q3 Content type / resolution
- Loader is by content, extension irrelevant, but **PNG only**: a JPEG written to `back.png` (`file` confirms JPEG data) renders solid magenta (255,0,255) fallback. So convert/validate to real PNG (decode and re-encode), never just rename.
- Different resolution/aspect works: 640x480, 1280x720 (wide) and 480x640 (tall) all displayed, each scaled to fill the 3:4 portrait preview and center-cropped (wide image text "WIDE E" clipped at the edges; 4:3 source shows the middle ~3/4 horizontally). Frames are not letterboxed. For QR/barcode scenes keep the subject centered with margin, ideally pre-crop to 3:4 portrait.
- Captured photo (main `CameraActivity`, shutter, back): JPEG 960x1280 (portrait crop of the feed), mean color matches the feed within JPEG error (`photo_back_imgD.jpg`: 71.5,40.1,62.8 vs feed 75.9,39.7,66.0). Capture pixel-matches the swapped image, so photo-capture assertions are feasible (compare with tolerance / crop, not byte hash).
- Untested (deliberately, to avoid destabilising the emulator): file missing/zero-length/partially written at open. A partial PNG would very likely hit the same magenta/decode-fail path, so always swap atomically (write temp in same dir + rename).

## Q4 Video / source switching at runtime
- Evidence only, no reboot done. The source type is fixed by the launch argv; there is no console/gRPC command to change a camera between `imagefile:` and `videofile:`.
- `adb emu help-verbose` camera-related: only `virtualscene-image <wall|table> [path]` ("customize virtualscene image for virtualscene camera"). It applies solely when the camera is the `virtualscene` type (the base AVD default), which renders a 3D room with posters; it is not a flat feed, so the QR subject appears in perspective, not a good fit. Untested because our `+cam` boot replaces virtualscene with `imagefile:`.
- `emulator -help-camera-back` lists `videofile:<filename>`. `advancedFeatures.ini` has `VideoPlayback = off` (default) -> `videofile:` almost certainly needs `-feature VideoPlayback` at boot (not run; confirm in CAM-4 before relying on it). Mode image vs video therefore needs a reboot with different argv; only image-file content swaps are free.
- For video loop: reopen semantics apply too (the file is bound at camera open).

## Q5 Timings / snapshot
- `warden dev` start -> device ready: emulator booted well inside the first 45 s of the dev run (dev start to `Starting Metro` + `waiting until it is ready` printed by 45 s; JSON line printed after the dev build install, ~153 s total incl. a local Android build, not a boot cost).
- Emulator log for this launch: `Boot completed in 15754 ms`.
- Snapshot: the +cam launch did not use the base golden snapshot (`warden-...`). Because argv has no `-no-snapshot-load`, the emulator tried `default_boot` and rejected it: `snapshot was created with gfxstream=0, but this emulator has gfxstream=1 ... The emulator is starting from scratch. Reason: different renderer configured`. So today it cold boots by accident (stale `default_boot`, unrelated to camera flags). Whether a golden snapshot would load with `-camera-*imagefile` args remains UNPROVEN: the emulator raised no camera-related objection, but no camera-flag snapshot load was exercised. Cold boot is ~16 s, which is acceptable.
- Camera permission flows: `CameraActivity` first run shows "Remember photo locations?" and a location permission dialog (deny). Granting `CAMERA`/`RECORD_AUDIO` was a no-op (already `GRANTED_BY_DEFAULT`).

## Recommendation for CAM-4
1. **Live swap = atomic in-place replace of the PNG at the stable path** (write temp in the same dir, validate/encode to real PNG, `rename` over `back.png`/`front.png`), no reboot. Report `rebooted: false`.
2. Doc/API caveat (also for `warden ui camera set`/`device.camera.set`): takes effect on the app's next camera open, not mid-preview. The driver should (optionally, behind a flag) restart the target app or expose "reopen camera" guidance (`am force-stop` + relaunch is what was verified; HOME also closes the camera device but app-level preview code may re-open late).
3. Reboot needed only for: image <-> video mode change, video feed (`videofile:` + probably `-feature VideoPlayback`, verify), first enabling a camera on a non-`+cam` device (identity change). Report `rebooted: true`.
4. Always convert to real PNG (decode with sharp/magick/Bun); reject or transcode JPEG/HEIC/etc. instead of renaming, or the preview turns magenta silently. Center the subject; document the center-crop to portrait (3:4 preview, photos 960x1280).
5. Atomic rename avoids torn reads; no symlinks needed (symlink also works, but a repointed symlink is not better than rename).
6. Fix the accidental `default_boot` attempt: pass `-no-snapshot-load` for `+cam` v0 (explicit cold boot, avoids the noisy rejected-snapshot warning and snapshot timing variance). If snapshot loads are wanted later, prove them with a golden built with the camera argv.
7. Pitfalls: log lacks camera init line without `-verbose`; `IMAGE_CAPTURE` extras don't choose front; location dialog on stock camera first run; swap while the file is being read mid-open is untested; leased emulators are reused, so restoring the grey placeholder at release (or on `clear`) is needed or the next claimer sees the previous image (the `+cam` identity limits it to +cam claimers, but still stale).

## Scratch evidence
`/private/tmp/claude-501/-Users-chris-orca-workspaces-warden-marron/28043c43-571b-4798-9aed-fce886d0866d/scratchpad/cam0b/` (screenshots `s*.png`, test images `img*.png`, `photo_back_imgD.jpg`, `dev.err`).
