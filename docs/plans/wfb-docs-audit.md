# WFB-DOCS: docs audit vs code (warden 0.1.1)

Plan ID: `WFB-DOCS` · parent: Warden user feedback (`feature/warden-user-feedback`) · branch `feature/wfb-docs-audit` · 2026-10-23

Trigger: feedback #1 (an Expo adopter). `installation.mdx` said the npm release of `@delacour/warden` was pending, but 0.1.1 is published and `npm i -g @delacour/warden` works.

## Phases

| ID | Phase | Status |
|---|---|---|
| WFB-DOCS-1 | 📝 docs: installation.mdx: npm is primary, from source is secondary, GH Actions uses npm or `github.token` (repo is public) | done |
| WFB-DOCS-2 | 📝 docs: full audit of `apps/docs/content/docs/**`, README, `packages/*/AGENTS.md`, `skills/warden/**` (8 parallel auditors split by section) | done |
| WFB-DOCS-3 | 🔧 chore: code / help-text follow-ups below (not docs) | open |

## Verification

- `bun run --cwd apps/docs build` passes. `@delacournz/otel-start` was already in the hoisted `node_modules` and `NPM_TOKEN` was set in this shell, so no fresh install was needed. A clean `bun install` still needs `NPM_TOKEN`; wfb-source-install is fixing that.
- `bun run typecheck` and `bun run check` pass.
- `apps/cli`: `bun test src/skill.test.ts src/commands/skill.test.ts src/commands/install.test.ts src/help.test.ts` gives 104 pass, 0 fail.
- An internal link and anchor check across every `.mdx` (`/docs/...` and `#anchor`) finds 0 broken. One was fixed: `agent-ui.mdx` `#selectors` → `#targets-and-selectors`.
- The `meta.json` nav already matched the pages on disk, so it is unchanged.
- No devices were claimed or booted.

## Findings applied (claim → evidence → fix)

### reference/cli.mdx
| Claim (as was) | Evidence | Fix |
|---|---|---|
| `run` flags omitted `--variant` | `run --help` | added |
| `batch --logs` had no default | `batch --help` | `<record dir>/logs`, else `$WARDEN_HOME/batches/<id>/logs` |
| `e2e` selection flags only alluded to | `e2e --help` | named `--base --platform --files --required-only --explain`; excluded job flags are `--jobs` and `--jobs-from` |
| `golden` was iOS-only, no `--platform` | `golden ensure/ls/prune --help` | `--platform ios\|android` (default ios), `ls`; `-y` applies only before `--all` |
| `port ls` undocumented | `commands/port.ts` | section added |
| `install` / `skill show` / `skill install` omitted `--json` and the `--from` default | `--help` | documented (`--from` defaults to `local`) |
| `ui network [n]` default, `ui eval/tree/logs/reload --metro` default, `ui record start` default path | `--help` | 50; `WARDEN_METRO_URL` → `state.json` → leased ports; `.warden-ui/<name>.flow.json` |
| `ui export --to` not marked required | `agent-ui/flows-register.ts:55-57` | required; `--force` overwrites |
| `affected --json` shape | `commands/affected.ts:116-124` | `{ suite, base?, changes, platforms[{ platform, selected, skipped, unreached, warnings }], warnings }` |
| `dev --count` | `commands/dev.ts:191` | documented: any value other than 1 is rejected |
| A stray paragraph split the `ui` table (the `eval` and `record` rows rendered as text) | markdown | moved below the table |

### reference/configuration.mdx + environment.mdx
| Claim (as was) | Evidence | Fix |
|---|---|---|
| `projects[].root` relative to the repo root | `config.ts:98` | relative to the config file, default `"."` |
| `eas.profile` had no default | `builds.defaults.ts:4` | `development-simulator`; without an `eas` section, EAS is used only if `eas.json` exists |
| `projects[].cacheDirs` missing | `define-config.ts`, `config.ts:109` | added |
| Variants vague; project picking undocumented | `define-config.ts` `WardenVariant`, `config.ts:125-140` | a variant replaces `fingerprint`, `eas` and `build`; the deepest root containing the cwd wins, else `--project` |
| Batch `ports` `FROM:SPAN`, `runtime` example `26.5` | `WardenBatchPreset` | `FROM[:SPAN]`, `latest`, `30s`/`10m`/`2h` |
| `devices[].profile` required-ness | `define-config.ts` | required, names the leg (`{leg}`, `WARDEN_LEG`) |
| Exported types list incomplete | `define-config.ts` | added `WardenConfig`, `WardenE2eMetro`, `WardenE2eSpec`, `WardenE2eDeviceLeg`, `WardenAppOption` |
| CI owner detection `CI` / `GITHUB_RUN_ID` | `core/owner.ts:17-22` | `CI` is `true`/`1` or `GITHUB_ACTIONS=true`; run id from `GITHUB_RUN_ID`, `CI_PIPELINE_ID` or `BUILDKITE_BUILD_ID`; `CLAUDE_SESSION_ID` added; CI outranks session |
| `WARDEN_HOME` holds the db, builds and skill | path grep | full layout: `warden.db`, `builds`, `batches`, `ccache`, `affected`, `logs`, `skill`, `ui`, `simd`, `android` |
| `WARDEN_HEADLESS=1` only | `headless.ts:10-12` | `1` or `true` |
| Missing vars | `golden.ts:57`, `android.ts:21`, `ui.ts:62-65`, `flow-sink.ts:53`, `Settle.swift:649`, `batch.ts:730,1058,1355` | added `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `NO_COLOR`, `FORCE_COLOR`, `WARDEN_UI_SECRET_<NAME>`, `WARDEN_SIMD_GUEST_MAX_AGE_S`, `WARDEN_LEG`, `WARDEN_METRO_URL`, `WARDEN_DEVICE_NAME` |

Left undocumented on purpose (build-time or internal): `WARDEN_E2E_VERSION`, `WARDEN_BUILD__`, `WARDEN_BINDING`, `WARDEN_PREFIX`, `WARDEN_NAME`, `WARDEN_HOOKS`, `WARDEN_CONFIG_FILES`, `WARDEN_IDB_SRC`, `WARDEN_UIAD_ANDROID_JAR`, `WARDEN_ANDROID_SDK`, `WARDEN_SIMD_UPDATE_GOLDEN`.

### guides/specs.mdx + reference/e2e-driver.mdx
| Claim (as was) | Evidence | Fix |
|---|---|---|
| `toContainText` had no options; `toHaveText` `exact` unexplained | `expect/matchers.ts:35,155-175` | `ignoreCase`; `exact: false` is a case-insensitive substring; every matcher takes `timeout`; unknown options throw (`assertOptions`) |
| Hooks get the same fixtures as tests | `runner/scope.ts:35`, `attempt.ts:349` | typed as base fixtures; hook order; `afterEach` runs after a failure |
| Actions take no `timeout`; `waitFor`, `press` keys, `swipe` and `scrollUntilVisible` options | `screen/locator.ts`, `screen/actions.ts:11`, `driver.types.ts:142` | `timeout` on every action; `waitFor` defaults; key and modifier list; `momentum`; defaults `down` and 10 swipes; the two `screen.swipe` shapes |
| `getBy*` options and role list | `screen/queries.ts`, `screen/roles.ts` | `exact`, `visible`, `name`; full role list; `INVALID_LOCATOR` |
| "Specs read the accessibility tree, not the React tree" | `locator.ts:259-269,350` | in a dev client, `getByTestId` falls back to the React tree for `tap` and `boundingBox` |
| `app.open` / `reinstall` | `app.ts:157-171,225`, `android-app.ts:176` | `url` and `env`; Android drops launch args; `reinstall` needs `WARDEN_APP_PATH` |
| `settle` / `screenshot` | `device.ts:225-260` | 250 ms quiet, 3000 ms timeout; the path is resolved |
| Version mismatch: "`warden e2e` refuses" | `preload.ts:35-58` | the preload exits 2 with the install fix |
| Artifacts are written only on failure | `attempt.ts:218` | `trace.jsonl`, `screenshots/` and `results.jsonl` are written for every attempt; `-p<pass>` suffix; `results.jsonl` fields |
| By-hand run needs only `WARDEN_UDID` | `env.ts:48-76` | also `WARDEN_BUNDLE_ID`; exits 2 on a bad env; default out is `.warden-e2e/<iso>` |
| Missing `OpenWaitUntil`, `describe({serial})`, `test.todo`, timeout precedence | `src/index.ts:1`, `runner/test.ts` | added |
| Socket at `~/.warden/simd/<udid>.sock` | `doctor-helper.ts:197` | `$WARDEN_HOME/simd/<udid>.sock` |
| Env table missing vars | `main.swift:104`, `driver/open.ts` | `WARDEN_SIMD_TRACE`, `WARDEN_E2E_DEBUG` |

### guides/e2e, run-e2e, affected-e2e, headless
| Claim (as was) | Evidence | Fix |
|---|---|---|
| Example app has five flows | `apps/example/e2e` | seven |
| `example` suite runs one `bun test` per flow | `affected.schema.ts` `suiteIsolation` | one process per device (flow isolation only by default when `passes` > 1) |
| `passes` > 1 is per-flow "unless it says otherwise" | `runIssues`, `e2e.ts` `runPlan` | `passes` > 1 with `isolate: "device"` is a config error |
| Failed-test dir contents | `runner/attempt.ts:357` | adds `console.jsonl`, `network.jsonl` |
| Job log names | `cli/e2e/jobs.ts` | `shard-<k>` under device isolation |
| No exit codes; no suite-less run | `commands/e2e.ts`, `affected.ts` `findSuite` / `defaultSuite` | 0 / 1 / 130; default suite |
| Failure screenshot is always simctl / screencap | `e2e/verdicts.ts` | the runner's `failure.png` is preferred |
| Lockfile, native or bundler change "selects every flow" | `select.ts`, `affected.defaults.ts` | only `runAll` globs do; `ignore` and `scope` |
| `e2e-report.json` shape incomplete | `E2eReport`, `FlowVerdict` | `device`, `log`, `screenshot`, `suite`, `platform`, `base`, `isolate`, `headless`, `batchDir`, `only`, `setup` |
| Graph built in "a separate `bun` process" | `commands/affected-graph.ts` | the binary's hidden `__affected-graph` subcommand |
| Boot is `simctl boot` + `bootstatus -b` | `core/providers/ios.ts` `bootReady` | `bootstatus -b` first, `boot` only as fallback |

### guides/agent-ui, agents + skills/warden
| Claim (as was) | Evidence | Fix |
|---|---|---|
| Collector gives up after 10 reconnects | `e2e/devtools/session.ts:20-22` | 30 s reconnect budget |
| Collector only ends as `lost` | `devtools/collector.ts:9`, `commands/ui-collect.ts:56` | also `idle` after 60 s |
| Android dump route path | `driver/android/android-state.ts:10,82` | `$WARDEN_HOME/android/<serial>.json` |
| Exit-2 codes lacked `device_busy` | `agent-ui/output.ts:21` | added (agent-ui.mdx, `ui.md`, `troubleshooting.md`) |
| `is --json` returns `{ matched, state, reason? }` | `agent-ui/query.ts:359` | `{ matched, state, element?, waitedMs, reason? }` |
| auto-gc only from `claim` / `run` | `claim.ts:87`, `run.ts:119`, `batch.ts:2016`, `dev.ts:440` | plus `batch` / `dev` |
| Claude install silently adds the hook | `install.ts` `guardedWrite` | diff, `--yes`, `--dry-run` |
| troubleshooting #12 "built-in 5×300 ms retry" | `driver/errors.ts` | no such retry; `E_AX_UNAVAILABLE` is marked retryable |
| A prose paragraph orphaned rows in the `ui.md` table | markdown | moved |
| `#selectors` anchor | headings | `#targets-and-selectors` |

### index, concepts, installation, updating, contributing, ports, app-builds
| Claim (as was) | Evidence | Fix |
|---|---|---|
| npm release pending (installation, README) | npm 0.1.1 | removed; npm is primary |
| GH Actions needs `WARDEN_RELEASE_TOKEN` PAT (repo private) | `gh repo view` → PUBLIC | `npm i -g` or action with `github.token` |
| Every agent-config change shows a diff | `install.ts:117,130-142` | only `settings.json` and Codex `hooks.json` prompt; the rule is written directly; the skill goes via `skills add`; agent detection |
| `doctor` check list | `doctor.ts:218-236,314` | ccache, `warden-simd` (`--fetch-helper`); only home and db failures exit 1 |
| Releases from the private repo; no provenance | `update/release.ts:6`, `release.yml` | public; provenance on; `--release` flag; `warden-simd` + `@delacour/warden-e2e` publish steps |
| Resources are only devices and ports | `core/types.ts:5` | plus the build lock |
| `--max` default | `allocate.ts:30`, `claim-flags.ts:100` | cores / 4, capped at 4, at least 1, never below `--count` |
| gc only shuts down idle devices | `commands/gc.ts`, `autogc.ts:9` | cache prune (20G, `--max-cache-size`), `--idle`, auto-gc every 10 min, `WARDEN_AUTO_GC=0` |
| Port range `FROM..FROM+SPAN` | `core/ports.ts:21` | ends at `FROM+SPAN-1`; `port ls` |
| Contributing layout | AGENTS.md | adds `apps/example`, `packages/e2e`, `packages/e2e-bench` |
| index only describes leasing; app-builds cache | `builds.defaults.ts:34`, `cache.ts:75-87` | `ui` / `e2e` bullet; 20G default, `WARDEN_MAX_CACHE_SIZE` |

### bench (guides/bench, bench/comparison, e2e-bench AGENTS)
| Claim (as was) | Evidence | Fix |
|---|---|---|
| Output in `packages/e2e-bench/.bench/<run>` | `e2e-bench/src/orchestrator.ts:636` | `<repo root>/.bench/<run>` |
| Commands omitted `list` and `summary`; output tree lacked `summary.json` | `cli.ts:79,151`, `args.ts:21-35`, `orchestrator.ts:451` | added; `run` and `report` both write it |
| Resources meaning | `report/markdown.ts:180-184` | CPU-seconds per warm rep is the headline |
| Fairness list missing a rule | `FAIRNESS_RULES` | "machine-readable reporters only" |
| AGENTS layout gaps | `harness/anr.ts`, `report/summary.ts` | added |

### README, packages/core/AGENTS.md, packages/e2e/AGENTS.md
| Claim (as was) | Evidence | Fix |
|---|---|---|
| npm pending banner; private repo; `WARDEN_RELEASE_TOKEN` PAT | npm, `gh repo view` | removed; public; `github.token` |
| `update` flags lacked `--release` | `commands/update.ts` | added |
| `golden` iOS-only; `arrange` / `doctor` missing from Usage | `golden.ts:209-226`, root `--help` | fixed / added |
| Bench listed Argent, agent-device and tester.army as current | retired | marked retired |
| core layout gaps | `packages/core/src` | `affected/`, `batch/`, `git-facts`, `headless`, `node-bin`, `shutdown-policy`, `providers/health`, `sims/slim`, `builds/{compiler-cache,js-inputs}` |
| e2e layout gaps | `packages/e2e/src`, `native/scripts` | `device-link`, `alert-*`, `traced-device`, `version`, `driver/{observation-cache,settle,traced-driver}`, native scripts |

## Out of scope: mismatches handed to sibling workspaces (not edited)

### wfb-source-install
- `updating.mdx` (release steps) and README "Releasing" step 4 say the release workflow needs an `NPM_TOKEN` that can publish to `@delacour`, and that it publishes without provenance "while the repo is private". In fact npm publishes go through OIDC trusted publishing with `--provenance`; `NPM_TOKEN` is only the GitHub Packages read token for `bun install` (`release.yml:40,119`). README also cites `WARDEN_NPM_REPO_LINKS=1`, which appears nowhere in source.
- The `installation.mdx` "From source" section doesn't mention `warden install --shim` (`install.ts:409`), which is what `cli:link` relates to.
- Docs build: it works locally only because `@delacournz/otel-start` is already hoisted; a clean `bun install` without `NPM_TOKEN` fails.

### wfb-hook-docs
- `cli.mdx` `hook session-end` paragraph: `hook pretool` is a silent no-op (confirmed by `--help`); "`warden install` removes the old hook" is unverified.
- README ("SessionEnd hook… removes the `PreToolUse` hook"), `agents.mdx`, `skills/warden/SKILL.md` and `rules/warden.md` ("Nothing intercepts simctl/adb", the removed `pretool` hook): left as is.

### wfb-xcode27-devicehub
- Simulator.app-only wording: `cli.mdx` (`arrange`, the `--headless` row, quick ref "tidy Simulator.app windows"), `headless.mdx` (items 1, 4, 5, "Watching a headless run"), `index.mdx` ("your Simulator.app"), `concepts.mdx`, `agents.mdx`, `skills/warden/references/suites.md`, README.
- Help text: `warden ui --help` and `warden e2e --help` say headless closes Simulator.app windows.

### wfb-ui-dev-lease
- `cli.mdx` `ui --force` row, `agent-ui.mdx` and `skills/warden/references/ui.md`: a live `e2e` / `batch` / `run` / `dev` process holding your lease makes `ui` exit 2 `device_busy` ("every subcommand but `status`"). This matches today's help; re-check once the fix lands. README "Driving a device" lease paragraph, same.

## WFB-DOCS-3: code / help follow-ups (not docs)

1. `.github/actions/install-warden/action.yml`: the description says "private delacournz/warden repo" and `token` asks for a fine-grained PAT. It should say the repo is public and that `github.token` works.
2. `apps/cli/src/commands/port.ts:161` and `lease-session.ts:163` (`--port` help): "FROM..FROM+SPAN" should be `FROM+SPAN-1` (`core/ports.ts:21`). Update the help snapshot.
3. `warden dev --help` lists `--count` (inherited claim flags) but `dev.ts:191` rejects anything other than 1. Hide it on `dev`.
4. `packages/e2e/src/app.ts:15-16`: the comment names `WARDEN_ASSERTION_TIMEOUT_MS`; the real variable is `WARDEN_E2E_ASSERTION_TIMEOUT`.
5. `packages/e2e/src/preload.ts:35`: the comment calls a version mismatch a warning, but the code exits 2.
6. `packages/e2e/src/runner/scope.ts:35`: the `Hook` type is the base fixtures, but the extended fixtures are passed at runtime. Type hooks with the extended fixtures.
7. `packages/e2e/src/env.ts`: `headless` and `worker` are parsed but never read. A bad `WARDEN_HEADLESS` still fails spec-env validation. `lease-session.ts:133` always exports `1`.
8. `--install-mode`, `--reset-keychain` and `--clean` need `--app`, but only `lease-session.ts` enforces it, so a suite with `app: false` plus a CLI `--install-mode` fails late instead of at config validation.
9. The no-config default suite hard-codes `platform: "ios"` and `count: 2`, with no Android default.
10. The `warden affected --help` example (`--jobs-from - -- <runner> {job} < <(warden affected ...)`) is confusing; simplify it.
11. `doctor-helper.ts:216`: darwin-x64 gets an `ok` row for the missing helper, while the docs say missing-helper rows warn.
12. `define-config.ts` `jobsFrom` is typed `string | { command }`; the docs show `string | "-" | { command: string }` (the `"-"` is redundant but harmless).
13. Bench: `e2e-bench/src/adapters/tester-army.ts:60` hard-codes `~/.nvm/versions/node/v24.19.0/bin` when `BENCH_NODE_BIN` is unset. The Android 2026-10-16 data has a negative warden `coldStartMs` (-1974), which the page shows as-is. `docs/bench/android-2026-10-18-slim-baseline.md` has no matching chart data.

Dismissed: "nested `<cmd> <sub> -h` prints root help". This was the auditors' zsh harness passing `"port claim"` as one argument; `warden port claim -h` works.
