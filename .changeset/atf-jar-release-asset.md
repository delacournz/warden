---
"@delacour/warden": minor
---

- `@delacour/warden-e2e` no longer carries the Android Accessibility Test Framework jar inline: the first Android `device.a11yAudit()` / `warden ui a11y audit` downloads it (~180 KB, sha256-checked) from the version's GitHub release and caches it in `~/.warden/atf/`. New releases go live on npm in minutes instead of waiting ~16 minutes in npm's automated review.
- New `WARDEN_ATF_JAR=<path>` points the audit at a local copy of the jar for hosts that cannot reach GitHub. Without it, an unreachable download skips the ATF engine with a warning; warden's own audit rules still run.
