---
"@delacour/warden": patch
---

- Closing a `warden view --detach` window on a running device now asks **Keep running** or **Shut down device** like an attached one. Shut down stops the device from the window; the lease stays (`stop_reason: user`) until `warden release`. A detached `--watch` window still just closes.
