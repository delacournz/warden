---
"@delacour/warden": minor
---

- `warden dev restart-metro [--clear] [--udid <udid>] [--json]` restarts a running `warden dev` session's Metro on the same leased port from another shell or an agent, keeping the device, leases, installed app and dev client. `--clear` resets Metro's cache; prints the new Metro URL (`--json`: `{ udid, metroUrl, clear }`).
- The `warden dev` dashboard gains `M` to restart Metro without clearing its cache (`c` still restarts with `--clear`); a restart requested from the CLI shows in the same row and waits for any running restart, reinstall or simulator restart.
