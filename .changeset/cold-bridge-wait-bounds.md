---
"@delacour/warden": patch
---

- iOS: a session's first read, while it retries a cold accessibility bridge (up to 60 s), now stops at the deadline of the `waitFor`, `expect` or `tap({ until })` it is part of instead of holding that wait for the whole 60 s
- iOS: a bound `rebind` after `app.launch` no longer counts as proof that the bridge is up, so a first read that stalls right after a launch still waits for the bridge instead of failing at once
- iOS: the e2e warm-up opens its driver with no cold budget of its own, so every `snapshot try N` in `logs/warm-<n>.log` is one read, 2 s then 5 s apart, instead of a nested 60 s loop
