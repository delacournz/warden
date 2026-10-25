/**
 * PostToolUse hook (Bash). After a command that opens a PR or moves a PR head (`gh pr create`,
 * `git push`, `gh pr merge --rebase`-style updates), remind the agent that the new head has no
 * `signoff` status and must be signed off before the PR is called ready. Emits nothing for
 * every other command. Wired in `.claude/settings.json`; rule in `.claude/rules/signoff.md`.
 */

type HookInput = {
	tool_name?: string;
	tool_input?: { command?: string };
};

// Only a real invocation at command position, not the words inside an echo, grep or commit message.
const AT_COMMAND = String.raw`(?:^|[;&|(]\s*)`;
const PR_OPEN = new RegExp(`${AT_COMMAND}gh\\s+pr\\s+create\\b`, "m");
const HEAD_MOVED = new RegExp(`${AT_COMMAND}(?:git\\s+push\\b|gh\\s+pr\\s+update-branch\\b)`, "m");

const raw = await Bun.stdin.text();
let input: HookInput = {};
try {
	input = JSON.parse(raw) as HookInput;
} catch {
	process.exit(0);
}

const command = input.tool_input?.command ?? "";
if (input.tool_name !== "Bash" || command.length === 0) process.exit(0);

const opened = PR_OPEN.test(command);
const moved = HEAD_MOVED.test(command);
if (!opened && !moved) process.exit(0);

const why = opened
	? "A PR was just created. It is unmergeable until its head carries the `signoff` status."
	: "The branch head moved. Any `signoff` status on the previous SHA is gone.";

const additionalContext = [
	`${why}`,
	"If this branch has an open PR into develop, load the `signoff` skill (.claude/skills/signoff) and run `bun run signoff` now (rule: .claude/rules/signoff.md).",
	"Do not report the PR as ready until `gh pr view --json statusCheckRollup` shows `signoff` SUCCESS on the current head.",
].join(" ");

console.log(
	JSON.stringify({
		hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
	})
);
