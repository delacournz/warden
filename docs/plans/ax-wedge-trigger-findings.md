# AX wedge trigger: findings (2026-11-06)

Question: what makes a sim's accessibility service wedge during warm-up on CI iOS 27.2 sims (~15% of sims on the old Namespace runner), and can it be prevented?

**Answer: it does not reproduce on the current CI setup, so there is nothing to prevent there.** In 69 boots on GitHub's `xcode-27` runner (iOS 27.2), fresh and golden-cloned sims, with and without the driver's in-sim `AutomationEnabled` write, warm-up snapshots never timed out. No prevention ships. The backboardd restart / reboot / quarantine ladder (#232 and this branch) stays as the recovery for when it does happen.

A wedge here means a warm snapshot that timed out (`E_TIMEOUT` / "did not answer within"), the same rule the warm-up uses before it asks for recovery. Other failures are not counted as wedges.

## What backboardd does at boot

From the iOS 26.5 `BackBoard.axbundle` (`-[AXBackBoardServerInstance _initServer]`):

- It reads `sysctl({CTL_KERN, KERN_BOOTTIME})`. Inside a simulator that is the **host's** boot time.
- If `now - boottime <= 99 s`, it calls `_AXSSetAutomationEnabled(0)`, which resets automation off. Otherwise it keeps the stored preference and logs `Still an ax enabler: _AXSAutomationEnabled`.
- So on a freshly booted CI VM, sims that boot in the first ~100 s take the reset path. Later sims keep whatever `AutomationEnabled` the clone carries. The golden recipe bakes `AutomationEnabled=true`.

Healthy boots log the guest turning automation on through the AX API (`SimulatorFrameworkBridge … Setting automation enabled: 1`). In the old Namespace evidence (runs 42248754529 and the fc–ga diag set), the wedged boots had no such line. That pointed at "automation enabled via the preference, not the API" as the trigger.

## Experiments

Throwaway branches with a capture script (`log stream` / `log show` of backboardd AX + SimulatorFrameworkBridge per booted sim). An in-job loop of `warden e2e example` iterations alternated two arms:

- **A (shipping behaviour):** the driver writes `AutomationEnabled` in the sim with `defaults write` when the host plist lacks it.
- **C:** no in-sim write; the clone's key is stripped before boot, so the guest has to turn automation on through the API.

| Run | Runner / runtime | Sims | Boots (A / C / main step) | Wedges (timeouts) | Other failures |
|---|---|---|---|---|---|
| 42298671102 | GitHub `xcode-27`, iOS 27.2 | fresh `simctl create` (golden off, #235 default) | 13 / 10 / 1 | 0 | 0 |
| 42305113216 | GitHub `xcode-27`, iOS 27.2 | cloned from a golden built in-run (`warden-golden-iphone-17-684bcd1f1b-r2`) | 22 / 22 / 2 | 0 | 1 `E_HELPER_CRASHED` (warden-simd exited), arm C, spec still passed |

Earlier, on the Namespace runner (golden on, n is small): arm B (key stripped, driver write kept) wedged 1/1, and the backboardd kickstart did not recover it. Arm A gave 1 ok boot and arm C 2 ok boots.

All 69 boots on the GitHub runner logged the guest's `Setting automation enabled: 1`, in both arms. Every boot also logged `First boot: YES`, golden clones included (the golden is exported unsettled).

At the old ~15%/sim rate, 0 wedges in 69 boots has a probability of about 0.85^69 ≈ 1e-5.

## What this rules in and out

- **Not the trigger on current CI:** golden clone vs fresh sim, or the driver's in-sim `defaults write` (arm A, 35 boots, 0 wedges).
- **Not a prevention:** skipping the write (arm C). It had the run's only failure, and that failure was a helper crash, not a wedge.
- **Not the trigger:** time from AX start to first use (seen earlier: wedged boots first touched ~122 s after AX came up).
- **Left standing:** the host. Every wedge we have came from the Namespace macOS runner (`namespace-profile-mac-medium`). The same runtime on GitHub's `xcode-27` image does not wedge. This was not isolated: running the loop on the Namespace runner again would tell runner from everything else that changed with #235.

## Recommendation

- Keep e2e CI on GitHub's `xcode-27` runner and the golden off by default (#235).
- Keep the recovery ladder; it costs nothing when there is no wedge.
- Do not ship the arm C change (stripping the clone's key / dropping the driver write): it has no measured benefit.
- If wedges come back (Namespace runner, a new runtime), re-run the loop there before changing code. The capture script and loop lived on the `diag/axw-loop*` branches (deleted); the workflow step is a `warden e2e … --count 2 --retry 0` loop that alternates a throwaway env switch, `WARDEN_DIAG_NO_AUTOMATION_WRITE`, read by a patched `enableAutomation` (not in shipping code).
