/**
 * What the warden skill (`skills/warden/`) deliberately leaves out, each with why an agent never needs it.
 * `skill-coverage.test.ts` fails when a visible command, subcommand or option is neither in the skill nor here,
 * and when an entry here names something that no longer exists or is now documented. Rule: `.claude/rules/skill-sync.md`.
 */

const HOOK = "run by the agent hook `warden install` writes, never typed";
const SETUP = "one-off human setup; the skill points at `warden install`";
const TUNING = "long-tail tuning; `--help` has it";

/** Command paths as typed after `warden` (`"hook session-end"`). */
export const SKILL_OMITTED_COMMANDS: Readonly<Record<string, string>> = {
	hook: HOOK,
	"hook session-end": HOOK,
	completion: "shell completion, set up by `warden install`",
};

/** `"<command path> --flag"` (`"perf query --index"`). */
export const SKILL_OMITTED_OPTIONS: Readonly<Record<string, string>> = {
	"release --session": "the SessionEnd hook's selector; agents release by id or `--mine --label`",
	"check --session": "the SessionEnd hook's selector",
	"heartbeat --session": "the SessionEnd hook's selector",
	"gc --max-cache-size": "auto gc prunes the build cache; agents use `warden builds prune --max-size`",
	"gc --quiet": "auto gc's own flag",
	"dev --scheme": "derived from the Expo slug; only for a custom dev-client scheme",
	"dev --ready-timeout": TUNING,
	"dev --hud-interval": "dashboard HUD, people only; agents run `--json`",
	"dev --no-open": TUNING,
	"dev logs --tail": TUNING,
	"perf js --sampling-interval": TUNING,
	"perf logs --lines": TUNING,
	"sims audit --stale": TUNING,
	"sims audit --owner": TUNING,
	"sims delete --suggested": "interactive disk cleanup for people",
	"sims delete --stale": "interactive disk cleanup for people",
	"clone --name": TUNING,
	"app ensure --no-install": TUNING,
	"builds import --hash": TUNING,
	"install --claude": SETUP,
	"install --codex": SETUP,
	"install --shim": "contributor-only (`bun run cli:link`)",
	"install --no-completion": SETUP,
	"skill show --file": TUNING,
	"skill install --agent": SETUP,
	"skill install --copy": SETUP,
};
