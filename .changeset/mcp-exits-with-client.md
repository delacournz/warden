---
"@delacour/warden": patch
---

- `warden mcp` exits when its client closes stdin or dies: it also stops on SIGTERM/SIGINT/SIGHUP and a broken stdout, and checks its parent every 2 s, so a killed client no longer leaves an orphaned `warden mcp` behind
