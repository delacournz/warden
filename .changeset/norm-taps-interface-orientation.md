---
"@delacour/warden": patch
---

- iOS: a tap, swipe, drag, pinch or gesture sent in normalized (`norm`) coordinates now scales by the way the app's interface is drawn, not the way the device is turned, so it lands on a portrait-locked app on a rotated simulator and on a landscape-only app on an upright one. Point coordinates (`warden ui press`, refs, spec taps) were already right in every orientation and are unchanged.
- The warden skill says that after `screen rotate`, snapshot frames, screenshots and `press x y` are in the app's interface space.
