---
"@delacour/warden": patch
---

- The XCUITest runner behind `warden ui` / `warden e2e` on a physical iPhone, and behind the accessibility audit on an iOS Simulator, serves only the warden process that started it. Each runner session gets a random token, passed to the runner in its environment; a connection must open with it, and the runner sends nothing and runs no op until it does. Commands and specs are unchanged.
- On an iOS Simulator the runner listens on `127.0.0.1` only.
- A resident iPhone runner host from an older warden is replaced on the next `warden ui` / `warden e2e` call, as after any runner change (stderr: `runner changed; restarting the iPhone runner host`).
