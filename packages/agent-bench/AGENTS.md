# @delacour/warden-agent-bench

Agent-in-the-loop benchmark: for each tool (warden, argent, agent-device) a Claude Code agent (`claude -p`) gets the same task, that tool's own Claude Code kit (skills, rules, CLI or MCP server) and one leased simulator, and drives the example app. The bench counts what it took (tool calls, driver calls, stumbles, error codes, turns, wall time, cost), runs the same success checks, diffs against each tool's baseline, and ends the report with a side-by-side comparison table. Private, never published, never in signoff or EAS: run it by hand on a Mac. It is separate from `packages/e2e-bench`, whose rule is zero LLM; it imports that package's harness (`exec`, `device`, `app`, `bench-app`, `results/write`) instead of copying it.

## Run

```bash
export CLAUDE_CODE_OAUTH_TOKEN=…            # `claude setup-token` (subscription), or ANTHROPIC_API_KEY
bun run bench app build --platform ios      # once: pins the example app under .bench/app/ios
bun run bench:agent list
bun run bench:agent login                   # suites/login.yml: warden, then argent, then agent-device
bun run bench:agent login --tools warden,argent
bun run bench:agent form --model claude-opus-5-5 --json
bun run bench:agent scroll --udid $UDID     # a device you leased; needs WARDEN_SESSION_ID of that lease
```

argent (`bun add -g @swmansion/argent`) and agent-device (`bun add -g agent-device`) run when they are on PATH; a missing one is an `unavailable` row. Exit 0 = every selected tool `passed`, 1 = any other outcome (incl. unavailable), 2 = usage / setup error (no credentials, no `claude`, no pinned app, no tool runnable, claim failed).

## Layout

| Path | Purpose |
|---|---|
| `src/cli.ts`, `src/args.ts` | `bench:agent <suite> [--tools a,b] [--model] [--udid] [--out] [--json]`, `list`; first Ctrl-C stops the running agent, still checks, reports and releases, later tools are `not_run`; a second exits 130 |
| `src/kit.ts` | `TOOL_IDS`, `resolveKit`: per tool the files copied into the sandbox, shims, MCP servers, env, `allowedTools`, failure patterns, `Driver` (how calls are counted), prompt preamble, and the e2e-bench adapter reused for doctor / prepare / teardown / residue |
| `src/bash-gate.ts` | the CLI kits' Bash gate, a `PreToolUse` hook (`bun bash-gate.ts <bin>`, via `claude --settings <sandbox>/settings.json`): allows a command when every segment (and `$(…)`) is `<bin>`, a variable assignment, a shell keyword or a read-only utility; denies the rest with a reason |
| `kits/agent-device/` | agent-device's skills (`skills/*/SKILL.md`) and recommended rule, vendored unchanged from its GitHub repo at the tag in `SOURCE.json` (npm ships none); MIT `LICENSE` |
| `src/suite.schema.ts`, `src/suite.ts` | zod suite schema (strict), `loadSuite` (YAML via `Bun.YAML`), `composePrompt` (kit preamble + task), `renderPrompt` (`{{udid}}`, `{{platform}}`, `{{bundleId}}`, `{{deviceFlag}}`) |
| `src/run.ts` | `runAgentBench`: preflight → resolve kits → claim once (`warden claim --ttl 4h --label bench`) → heartbeat 60 s → per tool: doctor → `isolate` → uninstall + install the pinned app → prepare (timed as `prepareMs`) → sandbox → `claude -p --output-format stream-json --verbose` → adapter teardown + kill its owned helpers → success checks → `warden ui close` → report → release by lease id |
| `src/sandbox.ts` | fresh `CLAUDE_CONFIG_DIR` with only the kit's skills and rules, empty work dir, the kit's shims first on PATH (warden: this checkout's `apps/cli/src/cli.ts`), `mcp.json` for an MCP kit; `authEnv` |
| `src/stream.ts` | stream-json parser (incremental; `onTurn` drives the turn limit) → `StreamMetrics` |
| `src/check.ts` | success checks as `warden ui wait <sel>` / `wait absent <sel>` / `is <sel> <state>` (exit 0 = pass) |
| `src/report.ts` | `report.json` schema (`reportVersion: 2`: one `tools[]` row per tool, ran or skipped), `diffBaseline`, `renderMarkdown` (per-tool sections, then `renderComparison`) |
| `suites/*.yml` | one suite per file; the file name is the suite name |
| `prompts/*.md` | the task prompts the suites point at |
| `src/fixtures/transcript.ndjson` | a real (trimmed) stream-json transcript the parser test reads |
| `<repo>/.bench/<run-id>/` | gitignored output: `report.json`, `report.md`, and per tool `<tool>/{transcript.ndjson,claude-stderr.log,prompt.md,sandbox/,adapter/}` |

## Suite file

```yaml
name: login                      # = file name
description: …
prompt: ../prompts/login.md      # the task only, relative to the suite file; each kit adds its own preamble
tools: [warden, argent, agent-device]   # default: all, in this order
platform: ios                    # default ios
app: example                     # the pinned bench app
model: claude-sonnet-5-5         # default; the same for every tool
maxTurns: 40                     # assistant messages before the bench stops the agent
timeoutMs: 600000                # default 10 min, process-group kill
maxBudgetUsd: 2                  # optional, --max-budget-usd
baseline:                        # optional, per tool; set from an agreed run
  warden: {toolCalls: 18, driverCalls: 16, stumbles: 1, wallMs: 150000}
failurePatterns: [SOME_CODE]     # optional extras; each kit already counts its own tool's codes
success:
  - wait: id=settings-screen     # also `absent: <sel>`, `is: <sel>` + `state: checked|visible|…`; `timeoutMs`
```

## Kits (what each agent gets)

| Tool | Skills + rules | Drives through | `allowedTools` | Prepare (not in wall time) |
|---|---|---|---|---|
| warden | `skills/warden/**` + `rules/warden.md` from this checkout | `warden` CLI (shim → `apps/cli/src/cli.ts`) | `Bash(warden *)`, `Skill`, `Read` | one `warden ui snapshot` (starts the helper) |
| argent | `skills/argent-*` + `rules/argent.md` from the installed package (what `argent init` installs, minus the `argent-environment-inspector` subagent) | `argent mcp` (only MCP server, `--strict-mcp-config`) | `mcp__argent`, `Skill`, `Read` | `argent server start --detach` |
| agent-device | `kits/agent-device/` (vendored skills + recommended rule) | `agent-device` CLI, `AGENT_DEVICE_STATE_DIR=~/.agent-device-bench/agent-device` (shared with e2e-bench) | `Bash(agent-device *)`, `Skill`, `Read` | `agent-device prepare ios-runner` |

Bash gate (warden, agent-device): Claude Code's `Bash(<bin> *)` rule alone denies any compound command with a segment it does not cover, so under `dontAsk` an agent that writes `U=<udid>; <bin> … --udid $U` is refused and gives up (both CLI tools "failed" that way on 2026-11-13). The gate's `allow` overrides `dontAsk`; its `deny` names the offending command so the agent can retry. argent has no Bash.

Fairness: same model, task text, device, pinned app, turn limit and timeout; every tool starts from a fresh install (`simctl uninstall` + `install`) after `isolate` (e2e-bench) clears the previous tool's helpers. The preamble only differs in how the device is handed over. Prepare is the e2e-bench adapter's (warden's is the bench's own snapshot, through the same CLI the agent uses), timed separately. After the agent, the tool's adapter teardown runs and any owned helper still alive is killed, so warden's success checks never share the simulator's accessibility with another client.

Refreshing agent-device's kit: bump the tag in `kits/agent-device/SOURCE.json`, re-fetch `skills/*/SKILL.md` and the "Recommended agent rule" block of `website/docs/docs/agent-setup.md` at that tag. A CLI whose version differs from the tag is noted in the report.

## Metrics

- `toolCalls`: every `tool_use`. `driverCalls`: calls to the tool under test: Bash running its CLI (`warden …`, `agent-device …`; also after `cd … &&`, `|`, `;`, env assignments) or a `mcp__argent__*` tool use; `driverVerbs` by verb (`ui press`, `press`, `gesture-tap`).
- `stumbles`: tool results with `is_error`, or naming one of the kit's or suite's failure codes (one per result); `errorCodes` per code. argent has no codes, so its stumbles are `is_error` only.
- `assistantTurns`: assistant messages while streaming (one model turn with parallel tool calls can be several), replaced by the final `result.num_turns`. The turn limit uses the streaming count, so it is conservative.
- `wallMs`: the `claude` process only (not claim, install, prepare or checks); `prepareMs` is the tool's warm-up. Cost and tokens come from the final `result` event.
- Comparison table (end of `report.md`): one column per tool; the lowest wall / turns / calls / stumbles / cost / tokens among tools that passed is bold.

## Rules

- The agent's world is the sandbox: no user CLAUDE.md, settings, hooks, plugins or MCP servers (`--strict-mcp-config`, `--setting-sources user` over the empty config dir). `HOME` is kept on purpose: the lease store (`~/.warden`) and simulator tooling live under it. An isolated config dir has no login, so credentials come only from `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`.
- The bench and the agent share one warden session (`WARDEN_SESSION_ID=agent-bench-<run-id>`), so the agent's `warden ui` calls see the bench's lease as their own; outer `CLAUDE_CODE_SESSION_ID` / `WARDEN_UDID*` are dropped from the agent's env. The agent never claims or releases (the prompt says so); the bench releases exactly the lease id it claimed. argent and agent-device know nothing of the lease: the bench holds it for the whole run, so no other warden session gets the device.
- Never kill another session's argent tool-server or agent-device daemon: teardown and isolation go through the e2e-bench adapters and `killMatching`'s owner filter (udid / run dir / private state dir).
- A new tool: an e2e-bench adapter first, then `TOOL_IDS`, a `resolveKit` branch, `baselinesSchema`, and the kit table above.
- Never spawn in `bun test` (no real `claude`, `warden` or simctl): inject `Exec` (`fakeExec` from e2e-bench). `src/fixtures/transcript.ndjson` is a trimmed real transcript.
- A new metric goes in `StreamMetrics`, the report schema (a compile-time guard ties the two), `renderMarkdown` and, when it compares tools, `ROWS` in `report.ts`. A breaking report change bumps `reportVersion`.
- Baselines are refreshed by hand, per tool, from a run the team agrees is representative (same model, same pinned app, same tool version), never from a run that stumbled on a flake.
- `Result` / `AsyncResult` from `@delacour/warden-types/result`; no `any`; no barrels; colocated tests; TDD.
