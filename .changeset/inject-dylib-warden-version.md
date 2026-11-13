---
"@delacour/warden": patch
---

- iOS specs find warden's injected library in the helper directory `warden doctor --fetch-helper` fills (`$WARDEN_HOME/simd/<version>`) when warden runs from source, so `device.keyboard`, network and clock conditions and the screen-reader reads work there instead of silently doing nothing.
