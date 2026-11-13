---
"@delacour/warden": patch
---

- iOS: a tap, swipe, drag, pinch or gesture sent in normalized (`norm`) coordinates now scales by the way the app's interface is drawn, not the way the device is turned, so it lands on a portrait-locked app on a rotated simulator and on a landscape-only app on an upright one. Point coordinates (`warden ui press`, refs, spec taps) were already right in every orientation and are unchanged.
- iOS: a snapshot of an app turned to landscape reports the landscape screen size, so elements on its right half are `hittable` and visible to specs (they were treated as off screen, and `tap` waited for them until it timed out).
- iOS: a read taken while the simulator is still rotating (`Simulator display changed during the operation`) is retryable, so `expect` and `tap` look again instead of failing at once.
- iOS: `warden ui screen rotate` and `device.orientation(set)` return once the rotation animation is over (about 0.7 s), so a tap right after them is no longer dropped.
- iOS: a hit-test on a landscape app measures the element against the landscape screen, so elements on the right half count as on screen.
- The warden skill says that after `screen rotate`, snapshot frames, screenshots and `press x y` are in the app's interface space and that a rotation returns once it has finished.
