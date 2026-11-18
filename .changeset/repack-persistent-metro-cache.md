---
"@delacour/warden": minor
---

- `warden repack` and `warden e2e` keep Metro's cache between repacks in `$WARDEN_HOME/metro-cache` (one per project, platform, bundle env, `.env*` files and bundler flags) instead of bundling with `--reset-cache`, so a JS change re-transforms only the files that changed. A project whose `metro.config.js` sets its own `cacheStores` keeps the reset. A cache restarts at 7 days old, other caches no repack used for 7 days are deleted, and `warden repack --force` empties the cache first.
- After upgrading, each cached repack is rebuilt once (the bundler flags are part of the JS key). On CI the e2e action's repack cache is keyed by the JS inputs alone, so each run rebundles until the JS inputs change; bump `cache-prefix` to refresh it at once.
- `warden ci cache --json` adds a `metro` group (`~/.warden/metro-cache`, keyed by the JS inputs, with `restoreKeys`); the e2e GitHub Action restores it on a repack cache miss and saves it after the app builds.
