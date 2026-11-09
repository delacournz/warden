---
"@delacour/warden": patch
---

- A `describe` (or spec file) whose tests are all skipped when collected no longer runs its `beforeAll` / `afterAll` hooks, and a `describe.serial` group in that state no longer opens the app
