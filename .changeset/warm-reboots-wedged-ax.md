---
"@delacour/warden": patch
---

- `warden e2e` iOS warm-up: a simulator whose accessibility service stays wedged after the backboardd restart (backboardd could not be restarted, or 3 snapshots in a row still time out on the fresh helper) is now rebooted once and reconnected, instead of running that device's specs cold. Only a simulator the run leased is rebooted, and only once its app install, setup and Metro launch are done; installed apps survive and a biometrics sim is enrolled again. The device's warm budget grows by 90 s when it reboots (the 120 s budget is unchanged otherwise). The warm-up log says `rebooting <udid>: …` then `rebooted; reconnecting`.
- `e2e-report.json` `warm[].axRecovery` gains `{ outcome: "rebooted" }`, and a failure carries `stage` (`log`, `restart` or `reboot`).
