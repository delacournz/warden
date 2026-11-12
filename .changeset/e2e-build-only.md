---
"@delacour/warden": minor
---

- New `warden e2e --build-only`: builds (or finds) the app the run would install into the cache, with the same suite, specs, kind, variant and bundle env, then stops before any device or spec. Exit 1 when the build fails; `--json` prints `{suite, platform, app}` (`app: null` when the suite installs no app). Not with `--dry-run`
- The `delacournz/warden/.github/actions/e2e` action builds the app with it in a step of its own before the suite, so `suite-timeout-minutes` times the specs only: a cold native build no longer runs the suite out of time. A failed build skips the suite. The `job timing` line adds an `app build` span
