---
name: changeset
description: Write a changeset for any change that ships in @delacour/warden or @delacour/warden-e2e. Use before committing, signing off or opening a PR that touches apps/cli, packages/e2e, packages/core, packages/perf, packages/types or skills/warden, when asked to "add a changeset", when a PR is missing one, or when a change already merged without one needs a retroactive changeset. Covers bump choice, body style and verification with changeset status.
---

# changeset

Changesets own the versions of `@delacour/warden` and `@delacour/warden-e2e` (lock-step via `fixed`). Each `.changeset/*.md` becomes a CHANGELOG entry and a bump when `version.yml` opens the version PR. No changeset = the change ships with the next release unnamed and unversioned.

## 1. Decide whether one is needed

```bash
git diff --stat origin/develop...HEAD -- apps/cli packages/e2e packages/core packages/perf packages/types skills/warden
```

Non-empty output, excluding `*.test.ts`, `*.testing.ts`, `__snapshots__`, `*.golden/`, `fixtures/` → a changeset is needed. Empty → none (docs, example app, bench, scripts, CI, `.claude`, configs).

Already have one? `ls .changeset/*.md` (ignore `README.md`). One changeset per user-facing change; add another rather than append unrelated bullets.

## 2. Pick the bump

| bump | when |
|------|------|
| `patch` | bug fix, perf, message/exit-code clarification; correct existing usage keeps working |
| `minor` | new command, subcommand, flag, option, env var, config key, spec/`expect` API, error code; a changed default |
| `major` | command/flag/API/config key removed or renamed; a previously passing spec now fails; a new hard requirement (Xcode/OS/Bun) |

When in doubt between patch and minor, pick minor.

## 3. Write the file

Path: `.changeset/<kebab-slug>.md`, slug names the change (`ui-record-authoring`, `paste-unicode-devicectl`). Never use `bun changeset` interactively in an agent session; write the file.

```md
---
"@delacour/warden": minor
---

- `warden ui record start|stop` journals every `warden ui` action and `stop` writes a typed `@delacour/warden-e2e` spec, then runs it once on the leased device (`--no-verify` skips).
- `WARDEN_UI_SECRET_<NAME>` values never land in the generated spec.
```

Rules for the body:

- Only `"@delacour/warden"` in the frontmatter. Never list `@delacour/warden-e2e`, `@delacour/warden-core` or any other workspace.
- Bullets, present tense, user-facing: what the user can now do / what now works, naming the command, flag, env var, option or error code in backticks.
- No file paths, module names, "refactor", "cleanup", "wip". Internal-only bullets are dropped, not written.
- Numbers only when they change a decision (a timeout default, a measured speed-up).
- Retroactive changeset for a commit already merged without one: write it on the current branch and put the original PR number in the first bullet, e.g. `` `warden foo --bar` (#NN): … ``, because changelog-github links the PR that carries the changeset file, not the original.
- Match the voice of the latest entries in `apps/cli/CHANGELOG.md`.

## 4. Verify

```bash
git add .changeset/<slug>.md
bun changeset status --since=origin/develop
```

`--since` only sees tracked files, so stage the changeset first.

Expect `@delacour/warden` (and `@delacour/warden-e2e` via fixed) with the chosen bump. A parse error means bad frontmatter: quotes around the package name, three dashes, a blank line before the body.

## Never

- Edit `version` in a `package.json`, or `CHANGELOG.md`, by hand.
- Run `bun run version` or `bun run release` locally; `version.yml` and `promote.yml` do that.
- Delete another PR's pending changeset.
