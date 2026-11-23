---
"@delacour/warden": patch
---

- `warden golden export` records a summary of the archived device tree (names, kinds, sizes, link targets) in `golden.json`, and leaves sockets and FIFOs out of the archive. `warden golden import` skips an archive whose tree no longer matches it (a partly restored cache) or whose symlinks lead out of the device's own directories, before it creates a device.
- An archive exported by an older warden has no summary and is skipped with that reason; the next claim builds the golden. The golden key from `warden ci cache` now ends `-a2`, so the e2e action's golden cache is rebuilt and saved once. A cache keyed on `warden golden key` alone keeps the old archive until that entry is deleted.
