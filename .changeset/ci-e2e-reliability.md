---
"@delacour/warden": patch
---

- `warden builds import --kind simulator-base` warns when the `.app` has no `application-identifier` entitlement (an app built with `CODE_SIGNING_ALLOWED=NO`, whose Keychain calls fail with `errSecMissingEntitlement` / -34018 in the simulator) and says to build with `CODE_SIGN_IDENTITY=-`; `--json` gains `applicationIdentifier`.
- The driver warm-up waits for `simctl bootstatus` before it starts a device's helper, so a golden clone that is still booting no longer answers the first snapshots with silence.
- Driver warm-up of separate `devices` legs runs one leg after the other, as the devices of one leg already did, instead of every leg at once.
- A host too small for one device (a 7 GB CI runner, where the 8 GB headroom leaves no budget) admits a lone claim while nothing else is booted, instead of queueing it for the whole `--wait`.
