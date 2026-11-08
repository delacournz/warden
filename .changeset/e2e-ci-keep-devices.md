---
"@delacour/warden": minor
---

- `warden e2e` no longer shuts down the simulators / emulators it created after a passed gate when running under `CI` (or `GITHUB_ACTIONS=true`): the runner is thrown away, so the shutdown only cost time. A suite's explicit `shutdown: "always"` still shuts them down; locally the default is unchanged.
