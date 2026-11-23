---
"@delacour/warden": minor
---

- `warden update --allow-downgrade` installs the latest release when it is older than the running binary. Without it an older release is never installed: `--force` reinstalls the same or a newer version only, and `--release` from a checkout build that is ahead of every release exits 1 naming the flag.
- `warden update --check --allow-downgrade` reports an older latest release as `available` (`older release available: <current> → <latest>`), the release the same command without `--check` installs.
