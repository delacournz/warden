---
"@delacour/warden": patch
---

- iOS runner builds (`warden ui` on an iPhone, the Simulator runner behind `audit`) and local iOS device app builds write an `.xcresult` bundle; `build_failed` / `local build failed` now name the first 5 compiler or signing errors with file:line, and the bundle's path.
- `E_XCODEBUILD_EXITED` from the iPhone runner and `E_HELPER_CRASHED` from the Simulator runner carry the test failure message (with file:line) from the bundle instead of only the last log lines, plus the bundle path (`detail.resultBundle` on `E_HELPER_CRASHED`).
- Only the last 3 bundles per runner cache and device are kept; an unreadable bundle falls back to the log tail as before.
