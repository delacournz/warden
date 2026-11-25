---
"@delacour/warden": minor
---

- `warden host attach --grant <key>` makes a machine with no inbound ssh (a CI runner, a fresh hosted Mac) a warden host without sudo: a user-level sshd that lets in only that laptop key, through the same forced command as `warden host grant`, reachable on the tailnet (`--tailscale`, `--advertise <addr>`) or through a bastion it dials out to (`--jump <user@bastion> --jump-port <port>`). It prints the laptop's `warden host add …` line and holds until Ctrl-C or `--for`.
- `warden host key` prints this laptop's warden key; `warden host add --granted` uses it for a host that already grants it, with no `host setup`.
