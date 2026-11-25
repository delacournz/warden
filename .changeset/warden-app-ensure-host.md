---
"@delacour/warden": minor
---

- `warden app ensure --lease <id>` (or `--udid`) on a device claimed with `warden claim --host` builds or fetches the app here, sends it to the host once per content hash, and installs it there through the host's driver; the JSON adds `host` and `hostPath`.
- A host keeps received builds under its warden home, takes only a build whose content matches its hash, and prunes builds unused for 7 days.
