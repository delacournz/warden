---
"@delacour/warden": patch
---

- iOS goldens: a build is promoted only when `AutomationEnabled` is on disk in the shut-down golden's Accessibility preferences. The in-sim `defaults write` can exit 0 before it is flushed. A golden already on the machine without it is deleted and rebuilt, and `warden golden import` skips an archive without it.
- `warden golden export` refuses (exit 1) a golden that was still busy when its first boot's settle wait ran out (`not settled after 300s … using it anyway`). That golden stays usable on the machine, but a CI cache no longer carries it to every later run. The mark lives in the golden's device dir, so an export in a later process sees it too.
