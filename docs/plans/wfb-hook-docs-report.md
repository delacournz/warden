# WFB hook docs — report

Branch `feature/wfb-hook-docs`, commit `92723e60` on top of `274e61ba`. Not pushed, no PR.

## Finding: PreToolUse removal was intentional

- Removed in `6fe4542b` (#25, WDN-E2E), sub-commit "🔥 chore: remove argent hook compat and YAML flow discovery (WDN-E2E-A12 part 1)":
  - dropped `ARGENT_MATCHER`, the PreToolUse handler, `patchArgentRules`
  - hook config keeps only SessionEnd; `warden install` removes the PreToolUse hook older versions wrote
  - `warden hook pretool` kept as hidden no-op so old installs don't break
- Code still reflects that: `RETIRED_HOOKS = ["pretool"]` (`apps/cli/src/hooks/claude-settings.ts:7`), hidden no-op in `apps/cli/src/commands/hook.ts:54`.
- Lease enforcement moved in-process into `warden ui` (`ensureLease` in `apps/cli/src/device-lease.ts`).
- Docs were never updated → stale claims. This branch fixes docs only; no behaviour change.

## Files changed

| File | Change |
|------|--------|
| `apps/docs/src/routes/index.tsx` | landing: "Agent hooks" → "Agent guardrails", PreToolUse row → `warden ui`, lede says one SessionEnd hook |
| `apps/docs/PRODUCT.md` | positioning + operating context: `warden ui` enforces leases, SessionEnd hook only |
| `apps/docs/content/docs/concepts.mdx` | "blocked hook" → "blocked `warden ui` call" |
| `apps/docs/content/docs/guides/agent-ui.mdx` | lease rules: no PreToolUse hook to install |
| `apps/cli/src/device-lease.ts` | doc comment drops PreToolUse caller |
| `apps/cli/src/hooks/claude-settings.ts` | `WardenHookSpec.event` narrowed to `"SessionEnd"` |
| `apps/docs/src/lib/agent-hooks.test.ts` | new drift test |

## Drift test

`apps/docs/src/lib/agent-hooks.test.ts` scans every `content/docs/**/*.mdx`, `src/routes/index.tsx` and `PRODUCT.md`; any line containing `PreToolUse` must also match `/older|removes|no PreToolUse/i` (i.e. only mentioned as retired). Fails with `file:line` list.

## Verification (2026-10-23, post-crash)

- tree clean
- `bun test apps/docs/src/lib/agent-hooks.test.ts` → 1 pass
- `apps/cli`: `bun test src/hooks src/device-lease` → 52 pass
- `bun run typecheck` → 10/10, `bun run check` → 12/12

## Open questions

1. Drop the hidden `warden hook pretool` no-op + `RETIRED_HOOKS` cleanup after N releases? a) keep indefinitely b) remove next minor c) remove after a deprecation note in changelog
2. Drift test allow-list regex is loose (`older`/`removes` anywhere on the line). a) fine as is b) tighten to explicit phrases
3. Skill / `rules/warden.md` outside this repo may still mention PreToolUse. a) audit separately b) ignore
