---
name: signoff
description: Sign off the current PR into develop by running this repo's local CI (`bun run signoff`), which runs the checks the diff needs and writes the `signoff` commit statuses branch protection requires. Use right after `gh pr create`, after every push to a branch with an open PR, after Update branch / rebase, when a PR is blocked on a missing or red `signoff` status, or before calling a PR ready to merge. Covers preflight, the dry-run plan, fixing a failing check, the CI escape hatch for checks this machine cannot run, and how to verify the status landed.
---

# signoff

`develop` branch protection requires one commit status, `signoff`. `bun run signoff` (`scripts/signoff/signoff.ts`) is the only thing that writes it: it diffs against the PR base, runs every applicable check from `scripts/signoff/signoff-checks.ts`, writes `signoff/<check>` per pass, then the `signoff` umbrella, then posts one report comment naming the actor and runner. A status binds to a SHA: every push drops it and this has to run again.

## 1. Preflight (each is a hard stop)

```bash
git status --porcelain                       # must be empty: commit (or ask), never sign off around uncommitted work
git rev-parse HEAD @{push}                   # must match: push first
gh pr view --json number,state,baseRefName   # must exist and be OPEN; base is normally develop
gh extension list | grep -q gh-signoff || gh extension install basecamp/gh-signoff
```

Shipping paths touched (`apps/cli`, `packages/e2e`, `packages/core`, `packages/perf`, `packages/types`, `skills/warden`) and no `.changeset/*.md` on the branch? Write one first (`changeset` skill), commit, push, then come back. A changeset added later means a new SHA and a new signoff.

## 2. Plan

```bash
bun run signoff -- --dry-run
```

Prints which checks run and which are skipped with the reason. Always-on: `typecheck`, `check`, `test`. Path-gated: `native` (`packages/e2e/native/**`), `cpu-guard` (`packages/e2e/**`, `apps/cli/src/agent-ui/**`, needs `WARDEN_BENCH_RUN_DIR`). A skip must be because no file matched, never because the check is slow.

## 3. Run

```bash
bun run signoff
```

Foreground, full output. Flags only when there is a reason to name:

| flag | use |
|------|-----|
| `--skip ctx,ctx` / `--only ctx,ctx` | writes the passed sub-contexts, **never the umbrella**; pair with the CI dispatch below so the umbrella still arrives |
| `--no-comment` | skip the report comment (a re-run that changed nothing) |
| `--base ref` | PR base is not what `gh pr view` reports |
| `--concurrency n` | lower it on a loaded machine |

Exit 0 and `signed off <sha> on PR #N` means done. Any other outcome is one of the cases below.

## 4. A check failed

Signoff is the job of getting the branch to a state worth signing off, not a report on it.

1. Re-run the one failing check alone for clean output (`bun run typecheck`, `bun run check`, `bun test <path>`, `bun run --cwd packages/e2e native:test`). Diagnose the root cause.
2. Fix the source. Never `--no-verify`, never skip a test, never loosen a type, never add `biome-ignore` to hide a real finding.
3. Re-run that check, then the full plan.
4. Commit with a gitmoji message describing the actual fix, push, go back to step 1 of this skill on the new SHA.

Stop and report (PR left unsigned) after three attempts on the same check, when the fix needs a user decision (behaviour change, dependency bump), when it reaches outside the PR, when the failure is environmental, or when it is flaky (green on re-run with no change: say so, do not call it settled).

## 5. A check cannot run on this machine

No Xcode for `native`, no bench run dir for `cpu-guard`: dispatch the workflow that runs the same checks against the same SHA and writes the same statuses. Dispatching runs the branch's code, so review a fork's diff first.

```bash
gh workflow run ci --ref "$(git branch --show-current)" -f signoff-sha="$(git rev-parse HEAD)"
gh run list --workflow ci --branch "$(git branch --show-current)" --limit 1
```

Then wait for it; do not also run `bun run signoff` with `--skip` expecting the umbrella.

## 6. Verify, then report

```bash
gh pr view --json headRefOid,statusCheckRollup --jq '{head: .headRefOid, signoff: [.statusCheckRollup[] | select(.context != null and (.context | startswith("signoff"))) | {context, state}]}'
```

`signoff` must be `SUCCESS` and `head` must equal `git rev-parse HEAD`. Report to the user: PR number, short SHA, checks run, checks skipped with reasons, anything still blocking. The wrapper already posted the report comment; do not post another.

## Never

- Bare `gh signoff` or `gh signoff create ...` by hand. It attests without running anything; only on an explicit user request, and then say in the PR that nothing ran.
- Call a PR ready, mergeable or done while the current head has no `signoff` SUCCESS.
- Carry a status forward to a new SHA, or sign off a dirty or unpushed tree.
- Make a path-gated context required in branch protection.
