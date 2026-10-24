# WFB source install: report

Branch `feature/wfb-source-install`, commits `515c3fe5` and `371022af` (on top of `274e61ba`). Not pushed, no PR yet.

## Problem

`bun install` in a fresh clone failed without `NPM_TOKEN`. `apps/docs` had a hard dependency on `@delacournz/otel-start`, which lives on GitHub Packages and needs a classic PAT with `read:packages`. So anyone installing from source (contributors, forks, `warden` from-source users) needed a token just to get the CLI building, even though only the docs server's tracing uses the package.

## What changed

- `apps/docs/package.json`: `@delacournz/otel` + `@delacournz/otel-start` moved to `optionalDependencies`. Without a token, Bun logs the 401 as a warning and the install still succeeds. `start` now preloads `./src/server/otel-preload.ts` instead of `@delacournz/otel-start/preload`.
- `apps/docs/src/server/otel.ts` (new):
  - `importOptional` swallows only Bun's `ERR_MODULE_NOT_FOUND` for the package itself. If the package is installed but one of its own deps is missing, that is a broken install and it still throws.
  - `loadServerSpan` returns `withServerSpan`, or `undefined` when the package isn't installed.
  - `otlpConfigured` detects `OTEL_EXPORTER_OTLP_*` / `DASH0_OTLP_*`.
  - The import specifiers are non-literal, so neither tsc nor the Vite/Nitro build tries to resolve the package.
- `apps/docs/src/server/otel-preload.ts` (new): runs the real preload when the package is installed. Otherwise it's a no-op, plus a warning if OTLP is configured (that deploy expected traces).
- `apps/docs/src/server.ts`: wraps `handler.fetch` with `withServerSpan` when available, else passes requests through untraced.
- `apps/docs/src/server/otel.test.ts` (new, 12 tests): covers missing vs broken package detection, scoped/subpath names, the loader shape check and `otlpConfigured`.
- Docs: the "From source" section in `installation.mdx`, `contributing.mdx` and the `bunfig.toml` comment now say the token is optional.

## Why not publish `@delacournz/otel` to npm?

- **It's a private-org package.** It comes from delacour-monorepo and serves Delacour apps. Publishing it publicly would make it a supported public API with semver obligations and wider supply-chain exposure (npm trusted publishing, provenance, name squatting) for a dependency that only the docs deploy needs.
- **The real dependency is narrow.** Only the hosted docs server traces. The CLI, the packages and local docs dev never need it. Making it optional fixes the from-source install with no change to the release process.
- **Fewer moving parts.** Publishing to npm means changing the monorepo's release pipeline and handling the GitHub Packages → npm migration across its other consumers. This change touches only this repo.
- **Reversible.** If the package later goes to npm for other reasons, change the scope in `bunfig.toml` and move it back to `dependencies`.

The trade-off is that tracing can silently disappear if a deploy loses its token. That's why the preload warns whenever OTLP is configured but the package is missing.

## Verification (2026-10-23, post-crash re-run)

- Worktree tree was clean. Ran `bun test apps/docs/src/server/otel.test.ts`: 12 pass, 0 fail.
- `bun run typecheck`: 10/10 pass. `bun run check`: 12/12 pass (32 warnings, all pre-existing in `apps/cli`).
- Fresh clone of the branch, with `NPM_TOKEN`/`NODE_AUTH_TOKEN` unset **and an empty `BUN_INSTALL_CACHE_DIR`**:
  - `bun install` and `bun install --frozen-lockfile` both exit 0, with `warn: ... @delacournz/otel{,-start} ... 401` in the output. `node_modules/@delacournz` is absent and `bun.lock` is unchanged.
  - `bun run typecheck` passes and the otel tests pass.
  - `bun run --cwd apps/docs build` succeeds.
  - `start` with `OTEL_EXPORTER_OTLP_ENDPOINT` set serves HTTP 200 on `/` and logs `[warden-docs] @delacournz/otel-start is not installed (NPM_TOKEN unset at install?): tracing is off`.
- Pitfall: without the empty cache dir, a "tokenless" clone still installs the package from Bun's global cache. Any future check of this needs `BUN_INSTALL_CACHE_DIR` pointed at an empty dir.

## Railway / CI impact

- **Railway (`warden-docs`)**: no change required. `NPM_TOKEN` is still a preserved variable, so the optional deps install and tracing works as before. The only runtime difference is that `start` preloads through a local shim. Confirm on the next deploy that traces still arrive and the warning line doesn't appear in the logs.
- **CI (`ci.yml`, `release.yml`)**: unchanged and still passes `NPM_TOKEN` to `bun install`, which is harmless. The token could now be dropped from both workflows, since nothing they build or test needs otel. Left as is to keep this change focused.
- **Signoff / forks**: contributors without a token can now run `bun run signoff` locally.

## Open questions

1. Drop `NPM_TOKEN` from the `bun install` steps in `ci.yml`/`release.yml`? a) yes, follow-up PR (recommended, less secret exposure); b) keep it
2. If a Railway deploy loses its token, should it fail instead of warning? a) warn only (current); b) exit non-zero when OTLP is configured but otel is missing
3. Publish `@delacournz/otel*` to npm later? a) no, keep it on GitHub Packages (recommended); b) yes, as a monorepo release-pipeline task
