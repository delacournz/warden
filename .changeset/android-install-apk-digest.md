---
"@delacour/warden": patch
---

- An Android app install is no longer skipped on a matching key alone: the emulator's installed `base.apk` must have the cached apk's sha256, so an emulator holding an older build of the same native build (an older `warden repack`, a restored snapshot) gets the current one without `--install-mode reinstall`. A truly identical build is still kept.
