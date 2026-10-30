---
"@delacour/warden": patch
---

- Two `warden dev` (or `--app`) runs on one checkout no longer both build the app: one local build runs per checkout and platform, the other waits (`waiting for the app build…`), then installs that build. A run that read its fingerprint while the other build was prebuilding now waits too, instead of building in the same tree and removing its `ios/` mid-build.
- A waiting run shows the running build's output live in its own log, from the first line.
- A checkout that changed while waiting, with nothing cached for the new fingerprint, fails with `the <platform> checkout changed since it was fingerprinted (A → B)`; run again.
