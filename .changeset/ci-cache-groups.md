---
"@delacour/warden": minor
---

- New `warden ci cache --json` prints the cache groups a CI job saves between runs (`builds`, `repack`, `golden`): each key, its paths, and for the golden the `warden golden import` / `export --allow-unsettled` commands to run around it. Flags: `--project`, `--prefix`, `--profile`, `--js-input`, `--golden-dir`
- The e2e GitHub Action gains `cache: github|none` and a `cache-groups` output: `none` skips `actions/cache` and the golden export but still imports the golden, so any cache (a Namespace volume, another CI) can store the listed paths
