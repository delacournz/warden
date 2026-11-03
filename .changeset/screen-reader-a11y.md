---
"@delacour/warden": minor
---

- Add `warden ui a11y audit|order|speak|announcements|spoken|focus`: audit the screen (`--rule`, `--ignore <rule[:identifier]>`, `--min-severity error|warning`, `--no-native`, `--text-size`; exits 1 when an issue is at or above the severity), print the simulated reading order and the phrase for one element, read announcements and live-region changes (`--since <cursor>`), and read or move real TalkBack focus and speech on Android.
- Add `warden ui a11y set` flags `--screen-reader`, `--reduce-transparency`, `--button-shapes`, `--differentiate-without-color`, `--on-off-labels`, `--high-contrast-text` and `--color-inversion` (each also `--no-…`). A setting the platform has no mechanism for is reported `skipped`; only skipped settings fail with `E_UNSUPPORTED`.
- Add `snapshot --a11y` (hint, custom actions, `a11y-focused`, `not-important`, live region per element), `open --a11y`, `warden e2e --a11y`, the `WARDEN_A11Y=1` env var, and the `a11y` suite and top-level config key (`rules`, `ignore`, `minSeverity`, passed to specs as `WARDEN_A11Y_AUDIT`) that launch iOS apps with the injected accessibility library.
- Add `device.a11yAudit()`, `device.screenReader.*` (`order`, `state`, `next`, `prev`, `activate`, `focused`, `spoken`), `device.announcements()` and `snapshot({ a11y: true })` to `@delacour/warden-e2e` specs, with the matchers `toHaveAccessibleName`, `toHaveRole`, `toHaveHint`, `toAnnounce`, `toBeA11yFocused`, `toPassA11yAudit` and `toHaveAnnounced`.
- iOS simulators now apply bold text, reduce motion, reduce transparency, button shapes, differentiate without colour and on/off labels live, and a simulated screen reader that makes `AccessibilityInfo.isScreenReaderEnabled()` true.
- Android emulators gain high contrast text, colour inversion and real TalkBack mode (`a11y set --screen-reader`, needs a Google Play image and `warden-uiad`); release puts the accessibility services back exactly as the device had them. With TalkBack on, `press` and `scroll` use accessibility actions.
- Audits also run the platform's own engine: XCUITest `performAccessibilityAudit` on iOS simulators and the Accessibility Test Framework on Android emulators. An engine that cannot run is reported `skipped` instead of failing the audit.
- Android apps now see reduce motion off by default under warden; `reduceMotion: true` (`--reduce-motion`) turns it on.
- Android emulators are unlocked at boot, which fixes `START_CLASS_NOT_FOUND` when launching an app on a locked emulator.
