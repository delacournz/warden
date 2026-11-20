---
"@delacour/warden": patch
---

- iOS claims, `warden golden ensure` and `warden golden import` now wait up to 60 s when `xcrun simctl create` refuses a listed runtime with `Invalid runtime` (seen on freshly booted CI images), asking again every 3 s and logging the wait. The error after the wait says how long the runtime refused.
- The `e2e` GitHub Action creates and deletes one iPhone on each available iOS runtime before the first claim, within 120 s, and only warns when a runtime still refuses.
