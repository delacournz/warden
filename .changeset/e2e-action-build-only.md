---
"@delacour/warden": patch
---

- The e2e GitHub Action takes `build-only: true`: it builds the app and saves the build, repack, compiler and Metro caches but runs no spec, and `passed` is the build's outcome. A suite with a golden still builds it on a cache miss and saves it too. Use it on a push to the default branch whose specs already ran on the pull request, to keep the caches every pull request restores warm without running the flows twice.
