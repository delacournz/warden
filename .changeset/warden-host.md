---
"@delacour/warden": minor
---

- `warden host add <name> --ssh user@host[:port]` records another Mac to drive over ssh and pins its host key; `--identity`, `--proxy-command`, `--jump` and `--host-key` cover keys, tunnels, bastions and pinning up front.
- `warden host setup <name>` installs this warden version on the host without sudo (the release, or `--binary`), fetches the iOS helper (`--no-helper` skips), builds the golden image with `--golden`, and grants this laptop's own key.
- `warden host doctor <name>` checks reach, key, version and the host's lease drift; `warden host ls` and `warden host rm` list and forget hosts.
- On the host, `warden host grant` / `revoke` / `grants` manage the laptops allowed in. A granted key only runs `version`, `claim`, `heartbeat`, `release`, `ls` and `doctor` with `--json`; everything else exits 2.
- New exit codes: 12 `HOST_UNREACHABLE`, 13 `HOST_AUTH`, 14 `HOST_VERSION_SKEW`, 15 `HOST_UNKNOWN`.
