---
"@delacour/warden": patch
---

- The e2e action always collects and uploads the `logs` artifact (native build logs), after a failed run too and whatever the `artifacts` input lists, even `none`. A failed run with `artifacts: all` now uploads `report,batches,logs,golden`.
