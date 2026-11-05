---
"@delacour/warden": patch
---

- `warden dev` dashboard: a running row spins and counts its time up, and the session row is a green dot with the session's age.
- The selected row is a highlight bar while the list has focus; the right side's first line names the row, its state (`running 12s`, `✓ done 1.3s`, `✗ failed`) and how far the log is scrolled.
- When a key's row finishes (`s`, `R`, `M` …) the footer shows its outcome for 3 seconds; the header shows `✗ metro exited (<code>)` once Metro dies.
- The `?` overlay groups warden's keys under navigate, app & device, Metro and perf, and the list footer names `r`, `s`, `M` and `p` while they fit.
