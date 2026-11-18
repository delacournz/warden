---
"@delacour/warden": patch
---

- Every iOS simulator boot a claim makes now logs how long each boot phase took, e.g. `warden: <udid>: booted in 98.0 s (booting 9.0 s, backboard 4.0 s, data migration 85.0 s)`, or `not ready after …` when it runs out of time. A new sim's first boot spends most of it in `data migration`, which a golden clone skips, so a slow `warden claim` / `warden e2e` start on CI can now be told apart from a slow host.
