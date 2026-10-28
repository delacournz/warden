---
"@delacour/warden": patch
---

- `warden e2e` bundles a `simulator` / `release` run's JS with the suite's `metro.env`, so `EXPO_PUBLIC_*` values such as a fake backend URL reach the repacked build (and its cache key) instead of `.env*` or the shell's values
