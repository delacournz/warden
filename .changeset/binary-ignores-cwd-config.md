---
"@delacour/warden": patch
---

- The `warden` binary no longer reads `bunfig.toml` or `.env` from the directory it is run in. Before, a checkout's `bunfig.toml` `preload` ran inside warden and its `.env` could set `WARDEN_*` variables (`WARDEN_HOME`, `WARDEN_SIMD`, `WARDEN_HELPER_URL`, …) for any command run there. warden's environment is now only what its caller passes: `export` a `WARDEN_*` variable you kept in a `.env`. Spec runs and the bundler load the project's `.env*` files as before.
- The repack `jsKey` covers the project's `.env*` files, git-ignored ones included, so a changed `EXPO_PUBLIC_*` value in a `.env` still makes a new repack. A project without `.env*` files keeps its keys; one with them repacks once.
