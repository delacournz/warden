---
"@delacour/warden": patch
---

- `tap({ until })` no longer takes elements that only moved (the screen a Back returns to, still sliding in) for a reaction to the tap: a tap dropped during the transition is now sent again instead of being waited out
