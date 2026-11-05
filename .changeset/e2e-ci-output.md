---
"@delacour/warden": minor
---

- `warden e2e` under GitHub Actions annotates each failed test on its spec file at the line it failed (`::error`, `::warning` for an optional spec) and appends a table of failed tests to the job's step summary
- `warden e2e --json-lines` streams NDJSON on stdout: a `test` event as each test finishes, then a `report` event with the whole report
- `warden e2e` ends with test totals, the error most failed tests share, and where the evidence is
- `e2e-report.json`: a failed test carries `line`, where it failed in the spec
