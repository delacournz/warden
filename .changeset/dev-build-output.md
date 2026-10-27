---
"@delacour/warden": patch
---

- `warden dev`'s dashboard streams the local build's own output (`expo run:ios`, xcodebuild, Gradle) into the dev build row while it runs, instead of showing nothing until the build ends. The `R` reinstall action streams it into its row too. Plain output (`--no-tui`, `--json`, pipes, agents) is unchanged.
