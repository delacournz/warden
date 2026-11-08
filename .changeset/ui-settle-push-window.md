---
"@delacour/warden": minor
---

- `warden ui snapshot --settle` and every action's `--settle` wait for 500 ms of unchanged screen (was 250 ms), so a navigation push is never reported settled mid-transition.
- `warden ui wait stable` defaults to 500 ms of quiet (was 250 ms); an explicit `wait stable <ms>` is unchanged.
