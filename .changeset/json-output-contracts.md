---
"@delacour/warden": minor
---

- `--json` output now carries `schemaVersion` on `warden claim`, `warden release`, `warden dev`, `warden app ensure`, `warden e2e` (the report, every `--json-lines` event and `e2e-report.json`), the `warden ui` envelope and every failure envelope. It goes up only for a breaking change.
- JSON Schemas for those outputs are published at `https://warden.co.nz/schemas/<schema>/<version>.json`, with `index.json` listing each one, the command that prints it and where. `warden ui snapshot`, `press`, `tap`, `fill`, `wait`, `is`, `get`, `open` and `close` each have one for their `result`.
