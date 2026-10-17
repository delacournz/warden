# Assignment 10 · `devtools-facet` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/10-devtools-facet.md` and `docs/audit/raw/10-devtools-facet.jsonl`.

## Improvement goal

Lower the RAM and reconnect churn of the Metro/Hermes devtools facet in dev-client runs, make it robust after a JS reload, and keep the `warden ui eval|tree|logs|network|reload` CLI path cheap.

## Owned files

- `packages/e2e/src/devtools/{cdp,session,inspector,console,network,network.script,tree,tree.script,collector,facet,metro,jsonl,devtools.types,devtools.testing,facet.testing}.ts` and tests (`cdp.test.ts`, `session.test.ts` 408, `tree.script.test.ts` 587, `console.test.ts`, `network.test.ts`, `collector.test.ts`, `facet.test.ts`, `inspector.test.ts`, …)
- `apps/cli/src/agent-ui/{devtools-cli,devtools-register}.ts`, `apps/cli/src/commands/ui-collect.ts` and tests (`ui-devtools.test.ts`, `ui-collect.test.ts`)
- Read-only context: `packages/e2e/AGENTS.md` layout row for `devtools/`; `docs/plans/wdn-e2e.md` § Devtools facet, "A7/A8 live verification", root causes 6–7 (device mismatch, `reloadJs`), "example-dev todos flake" (K14 context).

## Starting hotspots

- Ring buffers: console 500 / network 2000 entries, text bodies < 64 KB each: worst-case RSS per spec process; not cleared per attempt (K14) so `console.jsonl` of a dev run holds earlier tests' lines; propose the per-attempt mark/clear.
- `collector.ts`: the detached `warden ui-collect` process for `logs start`, 10-reconnect loop, idle exit, lifetime recorded in `state.json`: orphan cases when the app restarts or Metro dies.
- `session.ts` (365): `evaluate` round trip, `reloadJs` (`expo.reloadAppAsync` → `DevSettings` → `POST /reload`), `RELOAD_WAIT_MS`, reconnect on `executionContextsCleared`, `Runtime.enable` replay of buffered console lines (dedupe by timestamp+text: collisions?).
- `cdp.ts` (299): Bun WebSocket JSON-RPC, pending-request map growth, `Runtime.addBinding` callback registration, the `Origin` header, timeouts.
- `inspector.ts`: `GET /status` + `/json/list` per attach, target selection by `logicalDeviceId`/`deviceName` (two sims on one Metro), persisted id.
- `network.script.ts`: the injected `fetch` patch (headers, bodies, Metro filter); re-installation after reload; double counting with XHR excluded by design.
- `tree.script.ts` (465): fiber walk, `measureInWindow` fallbacks, 1200 ms guard, `--max` bounds; cost on a large screen; when `getByTestId` uses it as an accelerator.
- `facet.ts`/`device-devtools` attach: cost when `WARDEN_METRO_URL` is set but no test uses devtools.
- CLI: `warden ui eval` ≈ 0.7 s wall for `1+1` (`wdn-e2e.md:291`): split process start vs attach vs evaluate; `tree` 141–168 ms warm vs ~0.6 s wall.
