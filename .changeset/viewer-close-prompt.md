---
"@delacour/warden": minor
---

- `warden view` / `warden claim --remote --view`: closing the viewer window asks whether to keep the hosted device running or shut it down. **Shut down device** stops it and releases the lease; **Keep running** leaves both (the lease TTL applies, reopen with `warden view`).
- Ctrl+C on an attached `warden view` / `claim --remote --view` now stops the hosted device and releases its lease instead of leaving it running.
- `warden view --json` adds `released: true` and `remoteStopped` when the lease was ended on close.
