---
"@delacour/warden": minor
---

- `fill` (`locator.fill`, `warden ui fill`) types the text key by key by default again; `via: "paste"` / `--via paste` keeps the one-Cmd+V paste on iOS as an opt-in. On Xcode 27 every simulator's pasteboard is synced with the Mac clipboard in both directions, so a paste put e2e values (emails, passwords) into the Mac clipboard and clipboard managers, and during a parallel `warden e2e` / `warden batch` run onto the other simulators' pasteboards, where another test could paste them.
- `warden ui record` journals `via: "paste"` when a fill was pasted and nothing when it was typed; the generated spec passes `{ via: "paste" }` only. Recordings with `via: "type"` still load and generate a plain `fill`.
