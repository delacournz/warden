---
"@delacour/warden": minor
---

- Emulators warden launches now run the gRPC bridge (`-grpc <port> -grpc-use-token`) on a port leased with the emulator and released with it. `WARDEN_EMULATOR_GRPC=0` launches without it.
- `WARDEN_EMULATOR_GPU=<mode>` launches emulators with `-gpu <mode>`. `host` takes a headless emulator from ~15-20 fps (software rendering) to ~60.
- Android live stream: `stream.start|keyframe|stats|stop` on the Android device host, with the same replies and H.264 unit framing as the iOS helper.
  - Emulators stream through the new `warden-emud` encoder, which ships beside `warden-simd`.
  - Phones and emulators without the bridge fall back to `screenrecord` at half size. It is restarted before its 3-minute cap and switches over on a keyframe.
- The live-stream encoder no longer forces a keyframe after a frame that rate control skipped. Before, a full-size stream could fall into sending a keyframe on every other frame.
