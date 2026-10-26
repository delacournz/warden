---
"@delacour/warden": patch
---

- `warden dev` shows the simulator it leased: once the device is held it brings the sim's window to the front, launching Device Hub (Xcode 27) or Simulator.app (Xcode ≤ 26) when no viewer is running, instead of leaving the window behind other apps or never opening one. `--headless` skips it; a viewer that can't be opened is a warning, not a failure.
