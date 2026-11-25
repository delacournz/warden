---
"@delacour/warden": patch
---

- The iOS simulator helper can stream the device display as live H.264 (up to 60 fps, frames only when the screen changes, Constrained Baseline), the groundwork for a live `warden view` of local and host devices. Nothing in the CLI uses it yet.
