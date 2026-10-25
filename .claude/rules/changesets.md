# Changesets: every shipping change gets one

Versions of `@delacour/warden` and `@delacour/warden-e2e` are owned by changesets. A PR that reaches `develop` without one ships silently and unversioned. Load the `changeset` skill (`.claude/skills/changeset`) before writing one.

- **Shipping paths** (need a changeset): `apps/cli/**`, `packages/e2e/**`, `packages/core/**`, `packages/perf/**`, `packages/types/**`, `skills/warden/**` — anything bundled into the `warden` binary or the published spec API. Tests, fixtures and `*.testing.ts` alone do not count.
- **Non-shipping** (no changeset): `apps/docs/**`, `apps/example/**`, `packages/e2e-bench/**`, `scripts/**`, `.github/**`, `.claude/**`, `AGENTS.md`, `README.md`, biome/tsconfig configs, changeset files themselves.
- **When**: before the first commit that touches a shipping path, or at the latest before `bun run signoff` / opening the PR. One changeset per user-facing change; a PR may hold several.
- **How**: write `.changeset/<kebab-slug>.md` by hand (no interactive `bun changeset` prompt in agent sessions). Package line is always `"@delacour/warden": patch|minor|major` and nothing else; `@delacour/warden-e2e` follows via `fixed`.
- **Bump**: `patch` = fix / behaviour unchanged for correct use; `minor` = new command, flag, option, env var, spec API, or changed default; `major` = removed or renamed command/flag/API, or a spec that passed now fails.
- **Body**: bulleted, user-facing, present tense, names the command/flag/env var/error code; no file paths, no internal module names, no "refactor". Match the existing `apps/cli/CHANGELOG.md` voice.
- **Retroactive**: a change already merged without one gets its changeset on the current branch, with the original PR number `(#NN)` in the body.
- **Never**: edit `version` in any `package.json`, touch `CHANGELOG.md` by hand, or run `bun run version` / `bun run release` locally.
- **Verify**: stage the file, then `bun changeset status --since=origin/develop` must list `@delacour/warden` with the intended bump.
