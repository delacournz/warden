# Skill sync: every CLI change updates the warden skill

`skills/warden/` (SKILL.md, `references/*.md`, `rules/warden.md`) is embedded in the `warden` binary and installed for every agent by `warden install` / `warden skill install`. It is how agents learn the CLI. A command, flag, default or error code that changes without the skill teaches agents the wrong thing on every machine.

- **When** (in the same PR, without being asked): you add, rename, remove or change a command, subcommand, option, default, error code, exit code, env var, `warden.config.ts` key, `@delacour/warden-e2e` API or `warden mcp` tool; or you change behaviour the skill describes.
- **Where**: SKILL.md is a router (rules, which-path table, quick reference, facts); keep it ~100 lines and put detail in the matching reference: `ui.md` (`warden ui`, devtools), `perf.md` (`warden perf`), `specs.md` (spec API), `authoring.md` (`ui record`), `suites.md` (`e2e`, `affected`, `run`, `batch`, config), `cloud.md` (`login`, `whoami`, `billing`, `claim --remote`, `view`), `troubleshooting.md` (error → fix; never renumber, other files cite numbers). `rules/warden.md` only for an always-on rule.
- **Voice**: terse tables and bullets, the command as typed (`warden builds rm <hash>`), defaults and error codes verbatim from the code. Never document behaviour you have not read in the code.
- **Guard**: `apps/cli/src/skill-coverage.test.ts` fails when a visible command, subcommand or option is in neither the skill nor `apps/cli/src/skill-coverage.data.ts`, when the skill names a `warden <command>` that does not exist, or a `warden mcp` tool is missing. Document it; add an omission only for what agents never type (internal, human-only, long-tail tuning), with the reason. Never add an omission just to go green.
- The guard sees names, not meaning: a changed default, error code or behaviour is on you. Grep `skills/warden` for the command before you finish.
- **Changeset**: `skills/warden/**` ships, so it needs one (`.claude/rules/changesets.md`); a skill change that rides with the CLI change shares its changeset.
- **Verify**: `cd apps/cli && bun test src/skill-coverage.test.ts src/skill.test.ts`.
