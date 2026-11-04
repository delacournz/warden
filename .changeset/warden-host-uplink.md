---
"@delacour/warden": minor
---

- `warden host uplink` keeps one outbound link from a Mac to warden-api, so laptops reach it with no inbound connection at all. The host token comes from `WARDEN_HOST_TOKEN` or `--token-file`; `--api` picks the warden-api. Commands go through the same allowlist and leases as ssh.
- `warden host add <name> --cloud [--host-id <id>]` records such a host and reaches it with this laptop's `warden login` session. It keeps a hosted Mac's session end, so its leases are capped there.
- `warden dev --host` refuses a relayed host with a clear message: Metro needs an ssh port forward.
