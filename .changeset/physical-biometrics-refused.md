---
"@delacour/warden": patch
---

- Biometrics on a physical device are refused up front instead of being silently ignored: `--biometrics` with `--physical` / `--serial` / `--udid` fails the claim (`claim`, `run`, `batch`, `e2e`, `ui --claim`), and an `e2e` suite that sets both `physical` and `biometrics` is refused when `warden.config.ts` loads.
- `device.biometrics` and `warden ui biometrics` fail with `E_UNSUPPORTED` on a physical iPhone, as they already did on an Android phone: a real Face ID / Touch ID sensor cannot be enrolled or matched. A session on a phone never tries to enroll.
