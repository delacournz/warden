---
"@delacour/warden": patch
---

- An iOS read the bridge answered by the app's pid (when the frontmost app cannot be resolved) is no longer treated as a degraded read: absence checks on it are conclusive again, and `READ_DEGRADED` no longer says it "fell back from axbridge to axbridge"
