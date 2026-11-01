import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import { type CompletionShell, completionScripts } from "../completion-scripts";
import type { CommandContext } from "../context";
import { type Agent, hookAgents } from "../hooks/agents";
import { hookClaudeSettings } from "../hooks/claude-settings";
import { hookCodexHooks } from "../hooks/codex-hooks";
import { hookJson } from "../hooks/json";
import { hookTextDiff } from "../hooks/text-diff";
import { output } from "../output";
import { RULE_MD, SKILL_NAME, skillInstaller } from "../skill";
import { CLAUDE_AGENT, type SkillDeps, skillCli } from "../skill-cli";
import { type InstallOrigin, installOriginHelpers } from "../update/install-origin";
import { packageInstallHelpers } from "../update/package-install";

/** Hook commands reference the installed binary via `$HOME` so they work whatever PATH the agent runs with. */
export const HOOK_BINARY = "$HOME/.local/bin/warden";

/** How this process runs: a `bun build --compile` binary, or `bun src/cli.ts` from a checkout. */
export type Runtime = { kind: "compiled"; execPath: string } | { kind: "dev"; cliPath: string };

/** Outside world for `warden install` beyond `CommandContext` (prompts come from `ctx.ui`). */
export type InstallDeps = { runtime: Runtime; skill: SkillDeps };

export type StepName = "binary" | "skill" | "rule" | "settings" | "codex-hooks" | "completion";
export type StepStatus = "written" | "unchanged" | "skipped" | "declined" | "dry-run" | "failed" | "error";
export type StepReport = { step: StepName; status: StepStatus; path: string; detail?: string };

export type InstallFlags = {
	claude?: true;
	codex?: true;
	yes?: true;
	dryRun?: true;
	shim?: true;
	json?: true;
	/** false = `--no-completion` */
	completion?: boolean;
};
type Flags = InstallFlags;

/** `origin: "npm"` = a copy from an npx / bunx run, so `warden update` fetches it from npm. */
type BinarySource = { kind: "shim" | "binary"; content: string | Uint8Array; detail?: string; origin?: InstallOrigin };

const MARK: Record<StepStatus, string> = {
	written: "✓",
	unchanged: "✓",
	"dry-run": "·",
	skipped: "!",
	declined: "!",
	failed: "✗",
	error: "✗",
};

export class InstallCommand extends CliCommand {
	override readonly name = "install";
	override readonly group = "Setup";
	override readonly summary =
		"install warden to ~/.local/bin + hooks for detected agents (Claude Code: skill, rule, hook; Codex: hook)";

	constructor(private readonly deps: () => InstallDeps) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option("--claude", "install for Claude Code (default: every detected agent)")
			.option("--codex", "install for Codex (default: every detected agent)")
			.option("-y, --yes", "apply agent-config changes without asking")
			.option("--dry-run", "show what would change (diffs), write nothing")
			.option("--shim", "running from source: link ~/.local/bin/warden to this checkout")
			.option("--no-completion", "don't set up tab completion for $SHELL")
			.option("--json", "machine-readable output (diffs go to stderr)")
			.action(async (opts) => done(await this.runInstall(ctx, this.deps(), opts)));
	}

	private report(step: StepName, status: StepStatus, path: string, detail?: string): StepReport {
		return detail === undefined ? { step, status, path } : { step, status, path, detail };
	}

	private readIfExists(path: string): string | undefined {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	}

	/** Write via temp file + rename so a running binary / concurrent reader never sees a partial file. */
	private atomicWrite(path: string, content: string | Uint8Array, mode?: number): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, content);
		if (mode !== undefined) chmodSync(tmp, mode);
		renameSync(tmp, path);
	}

	private sameFile(a: string, b: string): boolean {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return false;
		}
	}

	private installBinary(ctx: CommandContext, target: string, runtime: Runtime, flags: Flags): StepReport {
		if (runtime.kind === "dev" && !flags.shim) {
			const appDir = resolve(dirname(runtime.cliPath), "..");
			return this.report(
				"binary",
				"skipped",
				target,
				`running from source — build a standalone binary with \`bun run --cwd ${appDir} build\` and run \`${appDir}/dist/warden install\`, or pass --shim to link this checkout`
			);
		}
		if (runtime.kind === "compiled" && this.sameFile(runtime.execPath, target))
			return this.report("binary", "unchanged", target);
		const source = this.binarySource(runtime);
		const current = existsSync(target) ? readFileSync(target) : undefined;
		if (current && Buffer.from(source.content).equals(current)) {
			installOriginHelpers.recordInstallOrigin(ctx.env, target, source.origin);
			return this.report("binary", "unchanged", target);
		}
		if (flags.dryRun) return this.report("binary", "dry-run", target, `would write ${source.kind}`);
		this.atomicWrite(target, source.content, 0o755);
		installOriginHelpers.recordInstallOrigin(ctx.env, target, source.origin);
		return this.report("binary", "written", target, source.detail);
	}

	/** `~/.local/bin/warden` for a source checkout: runs its `cli.ts` with bun. */
	devShim(cliPath: string): string {
		return `#!/bin/sh\nexec bun "${cliPath}" "$@"\n`;
	}

	/**
	 * What `~/.local/bin/warden` should be: a shim for a source checkout or a global npm/bun/pnpm install
	 * (a stable path its package manager upgrades in place), otherwise a copy of the running binary.
	 */
	private binarySource(runtime: Runtime): BinarySource {
		if (runtime.kind === "dev") {
			return {
				kind: "shim",
				content: this.devShim(runtime.cliPath),
				detail: `shim → ${runtime.cliPath}`,
			};
		}
		const managed = packageInstallHelpers.detectPackageInstall(runtime.execPath);
		if (managed && packageInstallHelpers.isStableInstall(managed)) {
			return {
				kind: "shim",
				content: `#!/bin/sh\nexec "${runtime.execPath}" "$@"\n`,
				detail: `shim → ${packageInstallHelpers.describePackageInstall(managed)}; \`${packageInstallHelpers.upgradeCommand(managed)}\` upgrades it`,
			};
		}
		const content = readFileSync(runtime.execPath);
		if (!managed) return { kind: "binary", content };
		return {
			kind: "binary",
			content,
			detail: `copied from ${packageInstallHelpers.describePackageInstall(managed)}; \`warden update\` or \`${packageInstallHelpers.upgradeCommand(managed)}\` refreshes it`,
			origin: "npm",
		};
	}

	/**
	 * Claude Code skill: stage the embedded folder under `$WARDEN_HOME/skill/warden` and let the `skills` CLI
	 * (`skills add … -a claude-code`) place it in `~/.claude/skills/warden`. Already-current on disk → unchanged.
	 */
	private async installSkill(ctx: CommandContext, deps: SkillDeps, dir: string, flags: Flags): Promise<StepReport> {
		const { missing, outdated } = skillInstaller.staleSkillFiles(dir);
		if (missing.length === 0 && outdated.length === 0) return this.report("skill", "unchanged", dir);
		const prefix = skillCli.runner(deps);
		if (!prefix)
			return this.report(
				"skill",
				"skipped",
				dir,
				"neither bunx nor npx found — install bun or node, or `warden skill show`"
			);
		const root = skillCli.localSkillRoot(ctx);
		const cmd = [...prefix, ...skillCli.skillsAddArgs(root, { agent: [CLAUDE_AGENT], yes: flags.yes })];
		if (flags.dryRun)
			return this.report("skill", "dry-run", dir, `would stage ${join(root, SKILL_NAME)} and run ${cmd.join(" ")}`);
		skillCli.stageSkillFolder(ctx);
		ctx.err(flags.json ? `warden install: ${cmd.join(" ")}` : ctx.ui.color.dim(`warden install: ${cmd.join(" ")}`));
		const code = await deps.runInteractive(cmd, { stdout: flags.json ? "stderr" : "inherit" });
		return code === 0
			? this.report("skill", "written", dir, cmd.join(" "))
			: this.report("skill", "failed", dir, `skills CLI exited ${code}`);
	}

	/** `~/.claude/rules/warden.md`: the always-loaded rule. */
	private installRule(ctx: CommandContext, path: string, flags: Flags): StepReport {
		const current = this.readIfExists(path);
		if (current === RULE_MD) return this.report("rule", "unchanged", path);
		if (flags.dryRun) {
			this.showDiff(ctx, flags, hookTextDiff.lineDiff(current ?? "", RULE_MD, path));
			return this.report("rule", "dry-run", path);
		}
		this.atomicWrite(path, RULE_MD);
		return this.report("rule", "written", path);
	}

	/** Rules from the retired agent-device / argent setup that exist under `claudeDir` (never deleted by install). */
	legacyRules(claudeDir: string): string[] {
		return ["agent-device.md", "argent.md"].map((f) => join(claudeDir, "rules", f)).filter((p) => existsSync(p));
	}

	/** Diff lines coloured like git: + green, - red, context dim. */
	private colorDiff(ctx: CommandContext, diff: string): string {
		const { color } = ctx.ui;
		return diff
			.split("\n")
			.map((line) => {
				if (line.startsWith("--- ") || line.startsWith("+++ ")) return color.bold(line);
				if (line === "@@") return color.cyan(line);
				if (line.startsWith("+ ")) return color.green(line);
				if (line.startsWith("- ")) return color.red(line);
				return color.dim(line);
			})
			.join("\n");
	}

	/** Human mode: coloured diff on stdout. `--json`: plain diff on stderr (stdout is the JSON report). */
	private showDiff(ctx: CommandContext, flags: Flags, diff: string): void {
		if (diff === "") return;
		if (flags.json) ctx.err(diff);
		else ctx.out(this.colorDiff(ctx, diff));
	}

	/**
	 * Show the diff, then write only on --yes or an interactive "yes". Non-interactive without --yes
	 * skips the step (naming the flag); "no" declines it; a cancelled prompt skips just this step.
	 */
	private async guardedWrite(
		ctx: CommandContext,
		flags: Flags,
		step: StepName,
		path: string,
		before: string,
		after: string
	): Promise<StepReport> {
		this.showDiff(ctx, flags, hookTextDiff.lineDiff(before, after, path));
		if (flags.dryRun) return this.report(step, "dry-run", path);
		if (!flags.yes) {
			if (!ctx.ui.interactive) return this.report(step, "skipped", path, "needs confirmation — re-run with --yes");
			const answer = await ctx.ui.confirm(`apply these changes to ${path}?`);
			if (answer === undefined) return this.report(step, "skipped", path, "cancelled");
			if (!answer) return this.report(step, "declined", path);
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, after);
		return this.report(step, "written", path);
	}

	private parseJson(text: string | undefined): Result<unknown> {
		if (text === undefined || text.trim() === "") return resultFactory.ok(undefined);
		try {
			return resultFactory.ok(JSON.parse(text));
		} catch (error) {
			return resultFactory.err(`invalid JSON: ${hookJson.errorMessage(error)}`);
		}
	}

	private async installSettings(ctx: CommandContext, flags: Flags, path: string): Promise<StepReport> {
		const before = this.readIfExists(path);
		const parsed = this.parseJson(before);
		if (!parsed.success) return this.report("settings", "error", path, parsed.error);
		const merged = hookClaudeSettings.mergeClaudeSettings(parsed.data, HOOK_BINARY);
		if (!merged.success) return this.report("settings", "error", path, merged.error);
		if (!merged.data.changed) return this.report("settings", "unchanged", path);
		return this.guardedWrite(ctx, flags, "settings", path, before ?? "", this.formatJson(merged.data.settings, before));
	}

	/** Pretty JSON keeping the existing file's tab indentation. */
	private formatJson(value: unknown, before: string | undefined): string {
		const indent = before !== undefined && /^\t/m.test(before) ? "\t" : 2;
		return `${JSON.stringify(value, null, indent)}\n`;
	}

	/**
	 * Codex: merge warden's hooks into `$CODEX_HOME/hooks.json`. Codex also reads `[hooks]` tables from
	 * `config.toml` (and merges both); warden hooks already declared there count as installed.
	 */
	private async installCodexHooks(
		ctx: CommandContext,
		flags: Flags,
		path: string,
		configPath: string
	): Promise<StepReport> {
		const toml = this.readIfExists(configPath);
		if (hookCodexHooks.codexTomlHasWardenHook(toml, "session-end")) {
			return this.report("codex-hooks", "unchanged", configPath);
		}
		const before = this.readIfExists(path);
		const parsed = this.parseJson(before);
		if (!parsed.success) return this.report("codex-hooks", "error", path, parsed.error);
		const merged = hookCodexHooks.mergeCodexHooks(parsed.data, HOOK_BINARY);
		if (!merged.success) return this.report("codex-hooks", "error", path, merged.error);
		if (!merged.data.changed) return this.report("codex-hooks", "unchanged", path);
		return this.guardedWrite(
			ctx,
			flags,
			"codex-hooks",
			path,
			before ?? "",
			this.formatJson(merged.data.settings, before)
		);
	}

	/** fish autoloads its completions dir; zsh / bash source warden's copy from their rc file. */
	private completionPaths(
		env: Record<string, string | undefined>,
		home: string,
		shell: CompletionShell
	): { script: string; rc?: string } {
		switch (shell) {
			case "fish":
				return { script: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "fish", "completions", "warden.fish") };
			case "zsh":
				return {
					script: join(storeLocator.wardenHome(env), "completion", "warden.zsh"),
					rc: join(env.ZDOTDIR ?? home, ".zshrc"),
				};
			case "bash":
				return { script: join(storeLocator.wardenHome(env), "completion", "warden.bash"), rc: join(home, ".bashrc") };
		}
	}

	/**
	 * Tab completion for `$SHELL`: the script is warden's own file (rewritten when it changes); the one
	 * `source` line appended to `.zshrc` / `.bashrc` goes through the diff + confirm like agent configs.
	 */
	private async installCompletion(
		ctx: CommandContext,
		flags: Flags,
		home: string,
		shell: CompletionShell
	): Promise<StepReport> {
		const content = completionScripts.completionScript(shell);
		const { script, rc } = this.completionPaths(ctx.env, home, shell);
		const scriptChanged = this.readIfExists(script) !== content;
		if (scriptChanged && !flags.dryRun) this.atomicWrite(script, content);
		const scriptStatus: StepStatus = !scriptChanged ? "unchanged" : flags.dryRun ? "dry-run" : "written";
		if (!rc) return this.report("completion", scriptStatus, script);
		const before = this.readIfExists(rc) ?? "";
		if (before.includes(script)) return this.report("completion", scriptStatus, rc);
		const gap = before === "" || before.endsWith("\n") ? "" : "\n";
		const after = `${before}${gap}\n# warden tab completion (added by warden install)\n[ -f "${script}" ] && source "${script}"\n`;
		return this.guardedWrite(ctx, flags, "completion", rc, before, after);
	}

	private async step(name: StepName, path: string, fn: () => StepReport | Promise<StepReport>): Promise<StepReport> {
		try {
			return await fn();
		} catch (error) {
			return this.report(name, "error", path, hookJson.errorMessage(error));
		}
	}

	/** `--claude` / `--codex` force those agents; with neither, every detected agent. */
	private targetAgents(ctx: CommandContext, flags: Flags): Agent[] {
		if (!flags.claude && !flags.codex) return hookAgents.detectAgents(ctx.env);
		const agents: Agent[] = [];
		if (flags.claude) agents.push("claude");
		if (flags.codex) agents.push("codex");
		return agents;
	}

	private async install(
		ctx: CommandContext,
		deps: InstallDeps,
		flags: Flags,
		home: string,
		agents: Agent[]
	): Promise<StepReport[]> {
		const binary = join(home, ".local", "bin", "warden");
		const steps: StepReport[] = [
			await this.step("binary", binary, () => this.installBinary(ctx, binary, deps.runtime, flags)),
		];
		if (agents.includes("claude")) {
			const claude = join(home, ".claude");
			const skillDir = join(claude, "skills", "warden");
			const rulePath = join(claude, "rules", "warden.md");
			const settingsPath = join(claude, "settings.json");
			steps.push(await this.step("skill", skillDir, () => this.installSkill(ctx, deps.skill, skillDir, flags)));
			steps.push(await this.step("rule", rulePath, () => this.installRule(ctx, rulePath, flags)));
			steps.push(await this.step("settings", settingsPath, () => this.installSettings(ctx, flags, settingsPath)));
		}
		const hooksPath = hookCodexHooks.codexHooksPath({ ...ctx.env, HOME: home });
		const configPath = hookCodexHooks.codexConfigPath({ ...ctx.env, HOME: home });
		if (agents.includes("codex") && hooksPath && configPath) {
			steps.push(
				await this.step("codex-hooks", hooksPath, () => this.installCodexHooks(ctx, flags, hooksPath, configPath))
			);
		}
		const shell = flags.completion === false ? undefined : completionScripts.shellFromEnv(ctx.env);
		if (shell) steps.push(await this.step("completion", shell, () => this.installCompletion(ctx, flags, home, shell)));
		return steps;
	}

	private installNotes(
		flags: Flags,
		agents: Agent[],
		steps: StepReport[],
		binaryPresent: boolean,
		home: string
	): string[] {
		const notes: string[] = [];
		if (agents.length === 0) {
			notes.push("note: no Claude Code or Codex detected — installed the binary only (--claude / --codex to force)");
		}
		if (agents.length > 0 && !binaryPresent && !flags.dryRun) {
			notes.push(`note: hooks call ${HOOK_BINARY}, which is not installed yet`);
		}
		if (steps.some((s) => s.step === "codex-hooks" && s.status === "written")) {
			notes.push("note: Codex skips new hooks until trusted — run /hooks in Codex to review and trust warden's");
		}
		if (steps.some((s) => s.step === "completion" && s.status === "written")) {
			notes.push("note: open a new terminal (or `exec $SHELL`) for warden tab completion");
		}
		if (agents.includes("claude")) {
			for (const p of this.legacyRules(join(home, ".claude"))) {
				notes.push(
					`note: ${p} is from the retired agent-device/argent setup — warden's rule is ~/.claude/rules/warden.md; delete it if unused`
				);
			}
		}
		return notes;
	}

	private mark(ctx: CommandContext, status: StepStatus): string {
		const { color } = ctx.ui;
		switch (status) {
			case "written":
			case "unchanged":
				return color.green(MARK[status]);
			case "dry-run":
				return color.dim(MARK[status]);
			case "skipped":
			case "declined":
				return color.yellow(MARK[status]);
			case "failed":
			case "error":
				return color.red(MARK[status]);
		}
	}

	private stepLine(ctx: CommandContext, s: StepReport): string {
		const { color } = ctx.ui;
		const detail = s.detail ? `  ${color.dim(`(${s.detail})`)}` : "";
		return `${this.mark(ctx, s.status)} ${s.step.padEnd(12)} ${s.status.padEnd(9)} ${s.path}${detail}`;
	}

	/** `warden install` with an injectable runtime (tests use a temp HOME + scripted prompts). */
	async runInstall(ctx: CommandContext, deps: InstallDeps, flags: InstallFlags): Promise<number> {
		const { color } = ctx.ui;
		const home = ctx.env.HOME;
		if (!home) {
			output.reportError(ctx, "install", "$HOME is not set");
			return 1;
		}
		const agents = this.targetAgents(ctx, flags);
		if (!flags.json) output.heading(ctx, "install", agents.length > 0 ? agents.join(" + ") : "binary only");
		const steps = await this.install(ctx, deps, flags, home, agents);
		const binaryPresent = existsSync(join(home, ".local", "bin", "warden"));
		const notes = this.installNotes(flags, agents, steps, binaryPresent, home);
		if (flags.json) {
			ctx.out(JSON.stringify({ steps, notes }, null, 2));
		} else {
			for (const s of steps) ctx.out(this.stepLine(ctx, s));
			for (const n of notes) ctx.out(color.yellow(n));
		}
		return steps.some((s) => s.status === "error" || s.status === "failed") ? 1 : 0;
	}

	/** Bun-compiled binaries run their entry from the embedded `/$bunfs/` filesystem. */
	detectRuntime(main: string = Bun.main, execPath: string = process.execPath): Runtime {
		return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/")
			? { kind: "compiled", execPath }
			: { kind: "dev", cliPath: main };
	}
}

export const install: InstallCommand = new InstallCommand(() => ({
	runtime: install.detectRuntime(),
	skill: skillCli.realSkillDeps(),
}));
export const installCommand = install.definition();
