---
"@delacour/warden": minor
---

- `warden view [leaseId|remoteId]` opens a hosted device in the warden viewer window, where you watch the screen and tap, swipe and type. With no argument it uses your only remote lease. `--watch` makes the window read-only, `--detach` leaves it open on one 30 minute token and returns, and `--json` prints `{ leaseId, remoteId, scope, detached, exitCode }` (plus `pid` when detached).
- While the window is open, `warden view` refreshes its token and keeps the hosted device and the lease alive. Closing the window or pressing Ctrl+C ends the command.
- `warden claim <platform> --remote --view` opens the viewer as soon as the device is ready and stays until it closes.
- The viewer is downloaded on first use for macOS and Windows and checked against the release's `SHA256SUMS`. `WARDEN_VIEWER_URL` points the download at a mirror, and `WARDEN_VIEWER_PATH` runs a local build.
