---
"@delacour/warden": minor
---

- `warden whoami` shows the Revyl approval code and link while an organization's hosted-device workspace waits for approval, and `--json` reports it as `remote.approval: { userCode, uri, expiresAt }`.
- `warden whoami --json` reports `remote.dashboard` when you can open the organization's Revyl dashboard from warden's web dashboard.
