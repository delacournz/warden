---
"@delacour/warden": patch
---

- iOS local builds (`warden builds`, `warden e2e`, `warden dev`) now actually use ccache: warden exports `CCACHE_BINARY` (the `ccache` on `PATH`, or your own `CCACHE_BINARY`), which React Native's compiler wrapper needs. Before, every compile skipped ccache and `~/.warden/ccache` stayed empty.
- `warden ci cache --json` prints `ccache: null` when the project sets `build.cache: false`, so the e2e action no longer installs, restores or saves a compiler cache the build never uses.
