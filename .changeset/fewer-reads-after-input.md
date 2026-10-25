---
"@delacour/warden": patch
---

- A `settle` no longer counts as input for the stable-frame rule: an action right after `app.open()` or a `device.settle()` that reported quiet trusts its one look instead of taking a second snapshot.
- On iOS, an action whose look followed a tap or a key within 300 ms confirms that its element has stopped moving with one hit-test instead of a second whole-screen snapshot (not with `systemAlerts` set, where the full look is what finds an alert).
