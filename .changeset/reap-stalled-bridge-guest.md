---
"@delacour/warden": patch
---

- iOS: when the accessibility bridge stalls after it had already answered, `warden-simd` ends the stuck guest so the next read starts on a fresh one with the cold first-read deadline (at most 3 times per helper, then the background check alone brings it back)
- iOS: the background check of a silent bridge backs off (every 5 s, doubling up to 30 s) and gets the cold deadline on a guest that is starting again, so a slow host can bring the bridge back instead of staying on `ax` for good; while it stays silent reads stay on `ax` without restarting the 20 s skip
