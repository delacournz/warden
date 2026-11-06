---
"@delacour/warden": minor
---

- `warden e2e`: a spec that was retried keeps what its earlier attempts met. `e2e-report.json` gives each retried spec a `failures[]` entry per earlier failed attempt (`attempt`, `device`, `log`, `screenshot` and the failed `tests[]` with `error`, `line`, `artifacts` and `bridge`), the terminal prints one dim `<spec> passed on attempt N — attempt M on <device>: <test> — <error> — log <path>` line per such attempt under a green gate, and under GitHub Actions a `::notice` per test an earlier attempt failed plus a table of the specs that passed on a retry in the step summary. A test entry in `tests[]` now also carries `bridge` (the iOS reads that left the accessibility bridge during the test) when there were any.
