---
"@delacour/warden": patch
---

- A simulated camera with a video feed delivers its first frame as soon as the app's capture session starts. The clip is opened and its first frame decoded when the feed is set (`device.camera`, `warden ui camera`), so an app on a slow host no longer sees a black camera for the first second, and the state ack now means the feed is ready.
