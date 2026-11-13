---
"@delacour/warden": minor
---

- `warden view` on a lease from `warden claim --host` opens the host's device in a browser tab on this Mac: live frames, click to tap, drag to swipe, keys to type (Esc = home). `--watch` is read-only and `--json` prints the page's link instead of opening it. It holds until Ctrl-C, which keeps the lease, or until the lease ends (exit 11). The page is served on 127.0.0.1 behind a random link.
