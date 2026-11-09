# @delacour/warden-agent-bench

Agent-in-the-loop benchmark: a Claude Code agent (`claude -p`) gets a task prompt, the warden skill and a leased simulator, and drives the example app with `warden ui`. The bench counts what it took (tool calls, `warden` calls, stumbles, error codes, turns, wall time, cost), runs a success check, and diffs against the suite's baseline. Private, never published, never in signoff or EAS: run it by hand on a Mac. It is separate from `packages/e2e-bench`, whose rule is zero LLM; it imports that package's harness (`exec`, `device`, `app`, `bench-app`, `results/write`) instead of copying it.

## Run

```bash
export CLAUDE_CODE_OAUTH_TOKEN=…            # `claude setup-token` (subscription), or ANTHROPIC_API_KEY
bun run bench app build --platform ios      # once: pins the example app under .bench/app/ios
bun run bench:agent list
bun run bench:agent login                   # suites/login.yml
bun run bench:agent form --model claude-opus-5-5 --json
bun run bench:agent scroll --udid $UDID     # a device you leased; needs WARDEN_SESSION_ID of that lease
```

Exit 0 = `passed`, 1 = any other outcome, 2 = usage / setup error (no credentials, no `claude`, no pinned app, claim failed).

## Layout

| Path | Purpose |
|---|---|
| `src/cli.ts`, `src/args.ts` | `bench:agent <suite> [--model] [--udid] [--out] [--json]`, `list`; first Ctrl-C stops the agent and still checks, reports and releases, a second exits 130 |
| `src/suite.schema.ts`, `src/suite.ts` | zod suite schema (strict), `loadSuite` (YAML via `Bun.YAML`), `renderPrompt` (`{{udid}}`, `{{platform}}`, `{{bundleId}}`) |
| `src/run.ts` | `runAgentBench`: preflight → claim (`warden claim --ttl 4h --label bench`) → heartbeat 60 s → terminate + install the pinned app → sandbox → `claude -p --output-format stream-json --verbose` → success checks → `warden ui close` → report → release by lease id |
| `src/sandbox.ts` | fresh `CLAUDE_CONFIG_DIR` with only `skills/warden/**` and `rules/warden.md`, empty work dir, a `warden` shim for this checkout's `apps/cli/src/cli.ts` first on PATH; `authEnv` |
| `src/stream.ts` | stream-json parser (incremental; `onTurn` drives the turn limit) → `StreamMetrics` |
| `src/check.ts` | success checks as `warden ui wait <sel>` / `wait absent <sel>` / `is <sel> <state>` (exit 0 = pass) |
| `src/report.ts` | `report.json` schema (`reportVersion: 1`), `diffBaseline`, `renderMarkdown` |
| `suites/*.yml` | one suite per file; the file name is the suite name |
| `prompts/*.md` | the task prompts the suites point at |
| `src/fixtures/transcript.ndjson` | a real (trimmed) stream-json transcript the parser test reads |
| `<repo>/.bench/<run-id>/` | gitignored output: `report.json`, `report.md`, `transcript.ndjson`, `claude-stderr.log`, `prompt.md`, `sandbox/` |

## Suite file

```yaml
name: login                      # = file name
description: …
prompt: ../prompts/login.md      # relative to the suite file
platform: ios                    # default ios
app: example                     # the pinned bench app
model: claude-sonnet-5-5         # default
allowedTools: ["Bash(warden *)", "Skill", "Read"]   # everything else is denied (--permission-mode dontAsk)
maxTurns: 40                     # assistant messages before the bench stops the agent
timeoutMs: 600000                # default 10 min, process-group kill
maxBudgetUsd: 2                  # optional, --max-budget-usd
baseline: {toolCalls: 18, wardenCalls: 16, stumbles: 1, wallMs: 150000}   # optional; set from an agreed run
failurePatterns: [stale_ref, E_TIMEOUT, target_not_found]                 # counted as whole words in tool results
success:
  - wait: id=settings-screen     # also `absent: <sel>`, `is: <sel>` + `state: checked|visible|…`; `timeoutMs`
```

## Metrics

- `toolCalls`: every `tool_use`. `wardenCalls` / `wardenUiCalls`: Bash calls running `warden …` / `warden ui …` (also after `cd … &&`, `|`, `;`, env assignments); `wardenVerbs` by verb.
- `stumbles`: tool results with `is_error`, or naming a `failurePatterns` code (one per result); `errorCodes` per code.
- `assistantTurns`: assistant messages while streaming (one model turn with parallel tool calls can be several), replaced by the final `result.num_turns`. The turn limit uses the streaming count, so it is conservative.
- `wallMs`: the `claude` process only (not claim, install or checks). Cost and tokens come from the final `result` event.

## Rules

- The agent's world is the sandbox: no user CLAUDE.md, settings, hooks, plugins or MCP servers (`--strict-mcp-config`, `--setting-sources user` over the empty config dir). `HOME` is kept on purpose: the lease store (`~/.warden`) and simulator tooling live under it. An isolated config dir has no login, so credentials come only from `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`.
- The bench and the agent share one warden session (`WARDEN_SESSION_ID=agent-bench-<run-id>`), so the agent's `warden ui` calls see the bench's lease as their own; outer `CLAUDE_CODE_SESSION_ID` / `WARDEN_UDID*` are dropped from the agent's env. The agent never claims or releases (the prompt says so); the bench releases exactly the lease id it claimed.
- Never spawn in `bun test` (no real `claude`, `warden` or simctl): inject `Exec` (`fakeExec` from e2e-bench). `src/fixtures/transcript.ndjson` is a trimmed real transcript.
- A new metric goes in `StreamMetrics`, the report schema (a compile-time guard ties the two) and `renderMarkdown`. A breaking report change bumps `reportVersion`.
- Baselines are refreshed by hand from a run the team agrees is representative (same model, same pinned app), never from a run that stumbled on a flake.
- `Result` / `AsyncResult` from `@delacour/warden-types/result`; no `any`; no barrels; colocated tests; TDD.
