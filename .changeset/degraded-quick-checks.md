---
"@delacour/warden": patch
---

- `isVisible()`, `isHidden()` and `count()` on a degraded iOS read (the bridge fell back to host `ax`, or the read came back empty) now look again for at most 2 s before failing `READ_DEGRADED`, instead of the whole action timeout. A spec branching on them is no longer held for 30 s; a healthy read still answers at once, and none of them ever returns "absent" from a degraded read. `text()`, `read()`, `waitFor`, actions and matchers keep the action timeout.
