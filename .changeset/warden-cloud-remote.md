---
"@delacour/warden": minor
---

- `warden login`, `warden logout`, `warden whoami` and `warden org list|use` sign in to warden cloud in the browser (device code), save the session to `~/.warden/auth.json` (owner-only), and show or switch the active organization. `WARDEN_TOKEN` and `WARDEN_API_URL` authenticate CI and pick another server.
- `warden claim <platform> --remote` leases a hosted iOS simulator or Android emulator from warden cloud. `--profile` / `--runtime` pick the model and OS version, `warden release` stops the hosted device, `warden heartbeat` keeps it from idling out, and `warden ls` lists it as `remote`.
