---
"@delacour/warden": minor
---

- `warden worktrees [--root <dir>…] [--idle 3d] [--no-fetch] [--no-size] [--json]` audits the linked git worktrees of every repo warden has leased for (plus the current one and any `--root`), with size and evidence: `merged`, `review` (uncommitted changes or commits on no remote), `unmerged`, `active` (changed within `--idle`), `in-use` (a process or live lease inside it), `locked` and `stale-ref`.
- `warden worktrees --apply` removes only clean `merged` worktrees with `git worktree remove` and prunes `stale-ref` entries. A merged PR counts only when its head is the worktree's HEAD. Branches are never deleted, and it refuses to remove the worktree you are standing in.
