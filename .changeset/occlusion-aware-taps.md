---
"@delacour/warden": patch
---

- `tap()`, `longPress()` and `scrollTo()` no longer press a control drawn over the target: a sticky footer (with its padded bar), a tab bar or a floating button later in the tree, or the header over a row scrolled past the top of its list. The press goes to the part of the target nothing covers, a wholly covered target in a scroll view is dragged clear first, and one that cannot be fails `NOT_ACTIONABLE` naming the cover.
- `scrollTo()` keeps scrolling until the target is clear of covers, dragging it just past a footer or header instead of a whole page.
- `tap({ until })` right after another input waits for the screen to settle before aiming, so it no longer taps where a sliding screen had the element.
