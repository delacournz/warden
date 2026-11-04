---
"@delacour/warden": minor
---

- `warden builds import <App.app> --kind simulator-base [--hash <nativeFp>]`: file a Release simulator `.app` built by another CI job as the base `warden e2e` / `warden repack` clone, so a fresh runner repacks its JS in seconds instead of building the native app again. The hash defaults to warden's own fingerprint of the project. The import refuses a device build, an `.app` without a slice for this Mac, another bundle id, a Debug or expo-dev-client build, and an executable that lost its mode bits; an embedded `main.jsbundle` is left out of the cached copy (`strippedBundle` in `--json`). `--hash` is now optional with `--kind`.
- `warden app fingerprint [platform] --kind dev|simulator|release`: print the native fingerprint that kind's build is cached under, plus its cache hash (`hashes` in `--json`, `<fp>:base` for the simulator base).
- `warden golden key | export <dir> | import <dir>` (iOS): carry the golden image between machines through a CI cache. `key` prints the golden's name (Xcode build, runtime build, device type and recipe), `export` copies the golden into `<dir>/<name>/`, and `import` registers each archive that matches this machine through `simctl create`, with no CoreSimulator restart. A stale, broken or missing archive is skipped with the reason and the golden is built on first claim as before.
