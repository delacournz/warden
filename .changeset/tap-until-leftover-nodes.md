---
"@delacour/warden": patch
---

- `tap({ until })` no longer takes elements leaving the screen for a landed tap. Right after a navigation, the screen it left and a keyboard going down stay in the accessibility tree until the transition ends, and a tap sent then is dropped; their leaving made `tap` stop re-sending, return after the full window without `until` ever showing, and the next assertion fail with "element not found". A tap now counts as landed only when something new shows or the tapped element is gone; otherwise it is re-sent from 750 ms on.
