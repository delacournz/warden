---
"@delacour/warden": patch
---

- `warden host doctor` no longer fails on lease drift in the host's own store (records of deleted devices, orphan claim keys). It prints a `warn leases:` line naming the finding kinds and how to fix them on the host (`warden doctor --leases --fix`), and exits 0. In `--json` the check has `ok: true, warning: true`. Reach, key, version or a broken `doctor --leases` call still fail.
