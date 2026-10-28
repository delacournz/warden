---
"@delacour/warden": patch
---

- `warden dev` on iOS opens the Expo dev client without the dev menu's first-run onboarding sheet or the dev menu covering the app at launch. The dev menu stays reachable by shake, ⌃D or the floating button.
- The warden skill says `warden dev ios` opens without the sheet, and that `warden ui open --relaunch` can still show it.
