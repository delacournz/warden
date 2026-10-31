---
"@delacour/warden": minor
---

- `warden login --account <name>` saves more than one warden cloud login; the first one is the default. New `warden account` lists them (`*` default, `>` the one this directory uses), `warden account default <name>` picks the default and `warden account rm <name>` removes one.
- New `warden org link [org] [--account <name>] [--path <dir>] [--remote]` binds a directory (by default the git top-level), or every checkout of a git remote, to an account and organization; commands run inside it use them with no `warden org use`. `warden org links` lists links and `warden org unlink` removes one. With no `<org>`, a terminal shows a picker.
- `WARDEN_ACCOUNT=<name>` and `WARDEN_ORG=<slug|id>` override the account and organization for one command; `WARDEN_ORG` also works with `WARDEN_TOKEN` in CI.
- Each request names its organization, so directories linked to different organizations can claim at the same time. A hosted device remembers the account and organization it was claimed under: `warden release`, `warden heartbeat`, `warden view` and `warden ls` reach it from any directory.
- `warden whoami` shows the account and why it was chosen (`account`, `accountVia`, `orgVia`, `link` in `--json`); `warden org list` marks the organization this directory uses; `warden logout` takes `--account <name>` and `--all`; `claim --remote` notes which organization it bills.
