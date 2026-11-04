---
"@delacour/warden": patch
---

- Simulated camera on iOS simulators: a video recording stopped before the encoder took its first frame (a short take, or any take on a busy host) no longer fails with "The operation could not be completed"; the recording holds the frame it started on.
