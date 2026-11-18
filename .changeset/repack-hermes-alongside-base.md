---
"@delacour/warden": patch
---

- When `warden e2e` / `warden repack` must build the iOS simulator base, the repack's Hermes compile now runs alongside the native build, right after the bundler, instead of after the base finishes. Only applying the bundle waits for the base. This takes about 1–1.5 minutes off a cold base on a 3-core CI runner. A JSC base still gets the plain bundle, and the log says `Hermes bytecode compiled while the base built`.
