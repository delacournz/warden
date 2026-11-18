---
"@delacour/warden": patch
---

- A freshly created iOS simulator no longer gets the pre-boot accessibility prefs before its first boot. Written that early, they wedged its accessibility service: `warden e2e` warm-ups and the first `warden ui snapshot` timed out (`E_TIMEOUT`, `E_AX_UNAVAILABLE`) until warden restarted it. A sim now gets them from its second boot on; `WARDEN_AX_PREFS=0` still turns them off.
