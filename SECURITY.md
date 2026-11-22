# Security policy

## Reporting

Report privately through GitHub: [open a draft advisory](https://github.com/delacournz/warden/security/advisories/new) (the repository's **Security** tab → **Report a vulnerability**). Please do not open a public issue, pull request or discussion for it.

Include the warden version (`warden --version`), the platform, what you ran and what happened.

## Supported versions

The latest release of `@delacour/warden` and `@delacour/warden-e2e`. Fixes ship in a new release; older versions are not patched.

## Scope

In scope:

- the `warden` CLI and its bundled helpers (`warden-simd`, the device drivers, `warden mcp`)
- the `@delacour/warden-e2e` spec API
- the install and update path (the npm packages, release assets, `warden update`)
- the reusable GitHub action in `.github/actions/e2e` and this repository's workflows
- the docs site, `warden.co.nz`

Out of scope:

- `warden.config.ts` and `*.e2e.ts` specs are code, and run as the user who starts warden
- leases are cooperative between processes of one user; they are not a boundary between users of one machine
- the example app (`apps/example`) and the benchmark harness (`packages/e2e-bench`)
- findings that need an already compromised machine or account
