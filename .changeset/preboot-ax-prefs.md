---
"@delacour/warden": minor
---

- iOS simulators warden creates get `AutomationEnabled` and `IgnoreAXServerEntitlements` written `true` into their Accessibility preferences on the host before every boot, so the accessibility server starts with automation on instead of the driver switching it on live. A simulator that has never booted is skipped until its next boot. `WARDEN_AX_PREFS=0` turns it off.
- The `warden e2e` GitHub Action builds every installed simulator runtime's dyld shared cache (`xcrun simctl runtime dyld_shared_cache update --all`, at most 10 min) before the first boot and logs `runtime dyld shared caches ready after N s`. A failure only warns. New input `dyld-cache` (default `true`; `false` skips).
