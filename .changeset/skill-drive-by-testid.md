---
"@delacour/warden": patch
---

- The `warden` skill teaches agents to drive `warden ui` in fewer turns: target `id=<testID>` instead of `@eN` in chains, batch known steps in one shell call with `&&`, `wait` on the destination instead of snapshotting after every step, and snapshot once at the end. It now says that a recent `@eN` taps the frame its snapshot stored (so it misses after a `fill` opens the keyboard), that a newer snapshot renumbers refs, and that `warden ui get` / `is` take a selector plus a property or state
