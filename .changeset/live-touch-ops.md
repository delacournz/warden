---
"@delacour/warden": patch
---

- The iOS and Android drivers can stream live touches (down/move/up, one or two fingers) as they happen instead of replaying a planned gesture: each move reaches the device in under a millisecond on the host. A finger left down for 10 s is lifted on its own. The groundwork for driving a live `warden view`; nothing in the CLI uses it yet.
