---
"@delacour/warden": patch
---

- `warden doctor --fetch-helper` from a release binary checks the `warden-simd` tarball against the sha256 the binary was built with, and no longer downloads `SHA256SUMS`. `--json` adds `helperFetch.checksum`: `embedded`, or `published` for a build from a checkout, which still checks against the release's `SHA256SUMS` and says so on stderr. A release binary never takes another release's helper.
- The helper tarball is unpacked only when it holds regular files, directories and symbolic links that stay inside it (the stub frameworks' `Versions/Current` links), all under its own root; hard links, devices and links that lead out are refused, and so is a tarball that cannot be read through to its end (a size field that is not octal, a pax `size` record, a cut-short archive). Unpacked files are `0755` when executable and `0644` otherwise.
- `WARDEN_HELPER_URL` and `WARDEN_NPM_REGISTRY` must be `https:` URLs, `http:` on `localhost` / `127.0.0.1`, or (the helper) `file:`; anything else is an error before any request. `warden update` from npm takes a tarball only from the registry's own host.
