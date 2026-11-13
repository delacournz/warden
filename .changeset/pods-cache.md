---
"@delacour/warden": minor
---

- New `warden pods install [--project-directory <dir>] [--no-cache] [-- <pod args>]`: `pod install` through a machine-wide cache. The same pods anywhere on the Mac restore into a new worktree by APFS clone in seconds with almost no extra disk (Expo: prebuild is skipped too). `--json` prints a `warden.pods.install` document.
- New `warden pods ls`, `warden pods rm <key…>` and `warden pods prune [--max-size 10G] [--older-than 30d]` manage the cache.
- warden's own iOS builds restore cached pods; `WARDEN_PODS_CACHE=0` opts out.
- `warden gc` prunes pods cache entries unused for 30 days.
