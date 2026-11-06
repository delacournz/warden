---
"@delacour/warden": patch
---

- iOS: while the accessibility bridge is skipped after a stall, `warden-simd` checks it in the background with one cheap hit-test (1.5 s deadline, at most every 5 s) and goes back to it as soon as it answers, instead of after the full 20 s; a silent check keeps reads on `ax` so no read pays the 4 s bridge deadline again
- iOS: a spec look that fell back to `ax` is returned at once instead of waiting up to 4 s on a second read through a silent bridge; the next look is back on `axbridge` once the check saw it answer
- iOS: a read that asks for `backend: "axbridge"` during the skip waits only for the background check, then fails with `E_TIMEOUT` if the bridge is still silent
- iOS: a cold guest whose background warm-up stalled is used again once the check sees it answer, instead of staying on `ax` until the next launch
