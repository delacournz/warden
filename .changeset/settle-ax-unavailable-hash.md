---
"@delacour/warden": patch
---

- iOS e2e and `warden ui`: when the native `settle` cannot bind the simulator's AX observer (`E_AX_UNAVAILABLE`, `AXObserverAddNotification(4002) failed with AX error -25204 (kAXErrorCannotComplete)`, seen on GitHub-hosted `xcode-27` runners while snapshots read fine by pid), that settle polls snapshot hashes instead of failing the step. After two in a row the session stops asking the helper's settle (each try cost about 3 s), with one log line. A native settle that works in between resets the count. The settle span records `nativeError: "E_AX_UNAVAILABLE"` and `via: "hash"`.
