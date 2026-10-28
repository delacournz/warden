---
"@delacour/warden": minor
---

- `warden disk [--json]` reports what is filling the disk on an agent machine, read-only: free space, swap, memory pressure, booted devices, APFS local snapshots (a staged macOS update vs Time Machine) and uptime, each warning with a one-line fix. Swap and snapshot warnings come first, since deleting files won't stop swap refilling the disk.
- It also lists what warden can give back: the build cache against its cap, deletable simulators, and orphaned Xcode DerivedData / XCTest device clones.
- Thresholds: free space under max(20 GB, 10%) warns, under max(8 GB, 4%) is critical, swap over 8 GB warns. Override with `WARDEN_DISK_FLOOR_GB`, `WARDEN_DISK_CRITICAL_GB` and `WARDEN_DISK_SWAP_WARN_GB`.
- `warden doctor` adds `disk-free`, `swap` and `snapshots` checks.
