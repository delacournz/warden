---
"@delacour/warden": minor
---

- `warden repack` and `warden e2e` keep Metro's cache between repacks in `$WARDEN_HOME/metro-cache` (one per project, platform, bundle env and bundler flags) instead of bundling with `--reset-cache`, so a JS change re-transforms only the files that changed. Caches no repack used for 7 days are deleted; `warden repack --force` empties the cache first.
- `warden ci cache --json` adds a `metro` group (`~/.warden/metro-cache`, keyed by the JS inputs, with `restoreKeys`); the e2e GitHub Action restores it on a repack cache miss and saves it after the app builds.
