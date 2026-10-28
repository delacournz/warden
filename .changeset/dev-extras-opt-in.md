---
"@delacour/warden": minor
---

- `warden dev` now runs only what the agent loop needs (dev build, Metro, simulator, app): the perf HUD sampler and the CDP devtools broker are off by default. `--hud` and `--devtools` start them with the session; `--no-hud` is still accepted.
- New `warden dev enable <hud|perf|devtools|all>`, `warden dev disable …` and `warden dev status [--udid] [--json]` turn those extras on and off in a running `warden dev` from another shell.
- The dashboard's `h` key now starts and stops the HUD sampler instead of only hiding the box.
- The mouse wheel no longer moves the task selection in the `warden dev` dashboard.
- `warden ui` devtools verbs on a session without a broker hint `warden dev enable devtools`.
