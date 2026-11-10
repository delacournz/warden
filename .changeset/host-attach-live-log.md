---
"@delacour/warden": patch
---

- `warden host attach` now shows a live log while it holds: when the laptop first connects, each warden command it runs there (`claim`, `release`, `doctor`, …; renewals stay quiet), commands it refused, and any key other than the granted one that connects or is refused. Each line is stamped with the local time.
