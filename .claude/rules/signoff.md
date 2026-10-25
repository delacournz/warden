# Signoff: every PR gets signed off, every time its head moves

PRs into `develop` merge on one commit status, `signoff`, written from the authoring machine by `bun run signoff` ([basecamp/gh-signoff](https://github.com/basecamp/gh-signoff)). GitHub Actions does not write it. A PR without it is unmergeable, and a PR with it that is pushed to again loses it. Opening a PR is half the job; signing it off is the other half. Load the `signoff` skill (`.claude/skills/signoff`) before running it.

- **When** (all of these, without being asked): right after `gh pr create`; after every `git push` to a branch with an open PR (a status binds to a SHA, the push dropped it); after **Update branch** / a rebase; when a PR is reported blocked on `signoff`; before telling the user a PR is "ready" or "mergeable".
- **How**: clean tree, HEAD pushed, PR open, then `bun run signoff`. It plans from the diff (`scripts/signoff/signoff-checks.ts`), runs every applicable check, writes `signoff/<check>` per pass and the `signoff` umbrella last, and posts one report comment. Nothing else writes statuses.
- **Order with changesets**: changeset first (`.claude/rules/changesets.md`), commit, push, then signoff. A changeset added after signoff is a new SHA and a new signoff.
- **Red check** = work to do, not a result to report. Fix the source, commit, push, run signoff again on the new SHA. Never weaken a check (`--no-verify`, skipped test, loosened type, `biome-ignore` on a real finding). Three failed attempts on the same check: stop, leave the PR unsigned, report.
- **Can't run a check here** (no Xcode for `native`, no bench dir for `cpu-guard`): dispatch CI, which writes the same statuses: `gh workflow run ci --ref <branch> -f signoff-sha=$(git rev-parse HEAD)`. Review fork code before dispatching.
- **Never** bare `gh signoff` / `gh signoff create`: it attests without running anything. Only on an explicit user ask, and then say so in the PR. `--only` / `--skip` write sub-contexts but never the umbrella, so they never make a PR mergeable.
- **Report**: the SHA signed off, the PR number, what ran, what was skipped and why. The report comment names the runner as an agent; do not post a second one.
- **Done means**: `gh pr view --json statusCheckRollup` shows `signoff` SUCCESS on the current head. Not before.
