---
"@delacour/warden": patch
---

- The e2e action no longer uploads the `golden` artifact after a green run whose golden was restored from the cache: the cache already holds it, and the GB upload was the slowest step of a warm run (~30 s). A failed run still uploads it, and `artifacts: golden` (or any list naming it) still collects it.
