---
"@delacour/warden": patch
---

- iOS: when a freshly started accessibility guest reports that the simulator's accessibility service did not answer, `warden e2e` and `warden ui` hand back its retryable timeout instead of reading the same warming service again through the host `ax` reader. Such a read still counts towards the accessibility-server wedge check, so a really wedged service is still restarted. On a fresh iOS simulator this stops the warm-up from timing out and the suite from running on degraded reads (`READ_DEGRADED`).
