---
"@delacour/warden": minor
---

- `warden dev [ios|android] --host <name>` runs the dev client on a device of a warden host while Metro stays on this machine: one `ssh -R` makes Metro answer on the host's loopback, the dev build is sent and installed there, and Ctrl-C releases everything here and on the host.
- A host's granted key may now run `port claim` / `port release` / `port ls` (`--json`; `--force` refused) for the host end of that forward.
