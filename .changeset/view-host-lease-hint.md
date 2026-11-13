---
"@delacour/warden": patch
---

- A bare `warden view` in a terminal that holds no device lease of its own no longer says to claim a hosted device when host leases exist (for example one claimed in another terminal): it lists them and says to run `warden view <leaseId>`.
