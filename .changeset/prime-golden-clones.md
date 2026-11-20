---
"@delacour/warden": patch
---

- On CI (`CI` or `GITHUB_ACTIONS` set), iOS sims cloned from a golden boot once and shut down before the claim boots them, so the claim's boot is the clone's second. A clone's first boot left the accessibility service silent on the e2e driver's first read, which cost ~100 s of backboardd restart or sim reboot on a 3-vCPU CI runner. The claim logs `primed the clone (first boot) in <s> s`; a failed prime logs `clone not primed (…)` and the claim boots the clone as before. Local claims are unchanged.
