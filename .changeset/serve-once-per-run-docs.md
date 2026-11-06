---
"@delacour/warden": patch
---

The `serve` of an e2e suite is documented as one process per run: started before the first spec and stopped after the last, shared by every device, leg, retry, `passes` repeat and shard, and never restarted. Specs must isolate their own state in it (for example a unique user per test). A test suite now holds `warden e2e` to this for `count`, `isolate`, `retry`, `passes`, `--devices`, a failing run and SIGINT.
