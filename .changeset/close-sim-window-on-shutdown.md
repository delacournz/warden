---
"@delacour/warden": patch
---

- Every simulator warden shuts down now has its viewer window closed, not only the one `warden dev` stops on a clean exit: `warden release --shutdown`, SessionEnd, `warden batch`, `warden gc` (stale leases and idle sims) and the capacity gate's idle shutdown. On Xcode 27 this stops Device Hub windows offering "Start" from piling up after a `warden dev` session whose terminal was closed.
