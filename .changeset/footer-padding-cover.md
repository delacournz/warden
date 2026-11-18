---
"@delacour/warden": patch
---

- A spec `tap()` / `scrollTo()` on a row that sits under only the padding of a sticky footer (clear of the footer's button) now scrolls it clear instead of tapping the footer, where the press did nothing.
- `scrollTo()` / `scrollUntilVisible()` on a row cut off by the bottom of its list and also under a sticky footer's bar now drags from above the bar. Every swipe used to start on the bar, so the list never moved ("still scrolled past the bottom … after 10 swipes", seen on Android).
