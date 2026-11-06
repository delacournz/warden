---
"@delacour/warden": minor
---

An `e2e.<suite>` can pin the iOS simulator runtime with `runtime` (`latest`, `iOS-26-5` or `26.5`), and `warden e2e --runtime <runtime>` overrides it. The run's devices and the golden they clone are the ones for that runtime, so `warden golden key --profile <p> --runtime <r>` names the archive the run uses. A runtime that is not installed fails the run before any claim, listing the installed runtimes, instead of falling back to another. `warden e2e`, `claim` and `batch` now also reuse an existing pool simulator when the runtime is given as a version (`26.5`, `27.0`), which only matched the `iOS-26-5` spelling before.
