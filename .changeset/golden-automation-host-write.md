---
"@delacour/warden": patch
---

Building an iOS golden simulator writes `AutomationEnabled` into the shut-down golden's plist on the host instead of running `simctl spawn defaults write` in the booted sim. The in-sim write timed out on the iOS 27 runtime on CI, which failed `warden golden export` and made `warden claim` fall back from a clone to a fresh boot. Existing recipe-2 goldens are still reused.
