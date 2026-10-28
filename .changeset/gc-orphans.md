---
"@delacour/warden": minor
---

- `warden gc` sweeps Xcode DerivedData whose recorded workspace no longer exists (the build output of deleted worktrees), and the `XCTestDevices` clone set once no `xcodebuild` has run for an hour. A workspace on an unmounted volume, a DerivedData dir that records none, or one an `xcodebuild` is using is kept; when running processes can't be inspected, nothing is removed.
- `warden gc --dry-run` lists those orphans with their sizes and changes nothing; `warden gc --no-orphans` skips the sweep.
