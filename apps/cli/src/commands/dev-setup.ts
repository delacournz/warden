import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectContext } from "@delacour/warden-core/builds/ensure";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { expoInstallCommand, missingPackages } from "../expo-app";
import { note, success } from "../output";
import { withSpinner } from "../spinner-context";
import { wardenConfigSource } from "./init.data";

/** What `warden dev` found missing or costly in the app, each with the fix it can apply. */
export type DevIssue =
	/** a package Metro's dev-client mode needs, with the install command for the checkout's package manager */
	| { kind: "package"; root: string; packages: string[]; command: string[] }
	/** the app's config is code (`app.config.*`): every start asks Expo for the bundle id unless a warden.config.ts holds it */
	| { kind: "config"; root: string; name: string; bundleId: { ios?: string; android?: string } };

export const DEV_SETUP_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The issues for this project, blocking ones first. */
export function diagnoseDev(context: ProjectContext): DevIssue[] {
	const { project } = context;
	const issues: DevIssue[] = [];
	// a bare React Native app runs itself against Metro: no dev client to install
	const missing = project.framework === "expo" ? missingPackages(project.root, ["expo-dev-client"]) : [];
	if (missing.length > 0)
		issues.push({
			kind: "package",
			root: project.root,
			packages: missing,
			command: expoInstallCommand(project.root, missing),
		});
	if (
		context.appConfig !== undefined &&
		project.source === "auto" &&
		!existsSync(join(project.root, "warden.config.ts"))
	)
		issues.push({ kind: "config", root: project.root, name: project.name, bundleId: project.bundleId });
	return issues;
}

/** One line per issue: what is missing and the command or file that fixes it. */
export function describeIssue(issue: DevIssue): string {
	switch (issue.kind) {
		case "package":
			return `${issue.packages.join(", ")} isn't installed in ${issue.root} — run: ${issue.command.join(" ")}`;
		case "config":
			return `${issue.root}/app.config.* is read through \`expo config\` on every start — \`warden init\` writes a warden.config.ts that skips it`;
	}
}

const blocking = (issue: DevIssue): boolean => issue.kind === "package";

const PRETTIER_CONFIGS = [
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.yml",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.mjs",
	"prettier.config.js",
	"prettier.config.cjs",
	"prettier.config.mjs",
];

/** Does a prettier config govern `root` (there or in a parent)? File names only. */
export function usesPrettier(root: string): boolean {
	for (let dir = root; ; dir = dirname(dir)) {
		if (PRETTIER_CONFIGS.some((f) => existsSync(join(dir, f)))) return true;
		if (dirname(dir) === dir) return false;
	}
}

/**
 * A file warden writes into a checkout that formats with prettier is run through the checkout's prettier
 * (via its package manager), so the repo's own format check stays green. Best effort: a missing or failing
 * prettier leaves the file as written.
 */
async function formatWithPrettier(ctx: CommandContext, root: string, file: string): Promise<void> {
	if (!usesPrettier(root)) return;
	const [runner] = expoInstallCommand(root, []);
	const command = [runner ?? "bunx", "prettier", "--write", file];
	try {
		const res = await ctx.exec(command, { cwd: root, timeoutMs: 60_000 });
		if (res.exitCode !== 0)
			note(ctx, `warden dev: ${command.join(" ")} failed (exit ${res.exitCode}); the file is unformatted`);
	} catch {
		// prettier is a courtesy
	}
}

export type DevSetupDeps = {
	/** writes a file (default: the filesystem) */
	write?: (path: string, content: string) => void;
};

/**
 * Offer each fix when a person is at the terminal: install the missing packages through the checkout's
 * package manager, write a `warden.config.ts` with the resolved ids. Without a terminal (or `--json`) the
 * blocking issues become the error, with their commands, and the rest a note. Resolves `changed` when a
 * fix was applied, so the caller resolves the project again.
 */
export async function offerDevSetup(
	ctx: CommandContext,
	issues: readonly DevIssue[],
	options: { interactive: boolean },
	deps: DevSetupDeps = {}
): AsyncResult<"changed" | "unchanged"> {
	if (issues.length === 0) return ok("unchanged");
	if (!options.interactive) {
		for (const issue of issues.filter((i) => !blocking(i))) note(ctx, `warden dev: ${describeIssue(issue)}`);
		const stop = issues.filter(blocking);
		return stop.length > 0 ? err(stop.map(describeIssue).join("; ")) : ok("unchanged");
	}
	let changed = false;
	for (const issue of issues) {
		const applied = await applyIssue(ctx, issue, deps);
		if (!applied.success) return applied;
		changed ||= applied.data;
	}
	return ok(changed ? "changed" : "unchanged");
}

/** One prompt + fix; true when applied. A declined blocking fix is the error; a declined optional one is skipped. */
async function applyIssue(ctx: CommandContext, issue: DevIssue, deps: DevSetupDeps): AsyncResult<boolean> {
	const write = deps.write ?? ((path, content) => writeFileSync(path, content));
	switch (issue.kind) {
		case "package": {
			const what = issue.packages.join(", ");
			const answer = await ctx.ui.confirm(
				`${what} isn't in ${issue.root}/package.json. Add and install it now? (${issue.command.join(" ")})`,
				true
			);
			if (answer === undefined) {
				ctx.ui.cancelled("Aborted.");
				return err(describeIssue(issue));
			}
			if (!answer) return err(describeIssue(issue));
			const res = await withSpinner(ctx, `installing ${what}`, (sctx) =>
				sctx.exec(issue.command, { cwd: issue.root, timeoutMs: DEV_SETUP_INSTALL_TIMEOUT_MS })
			);
			if (res.exitCode !== 0) {
				const tail = (res.stderr || res.stdout).trim().split("\n").filter(Boolean).slice(-5).join("\n");
				return err(`${issue.command.join(" ")} failed (exit ${res.exitCode})${tail ? `:\n${tail}` : ""}`);
			}
			success(ctx, `warden dev: installed ${what} (${issue.command.join(" ")})`);
			return ok(true);
		}
		case "config": {
			const id = issue.bundleId.ios ?? issue.bundleId.android ?? "?";
			const answer = await ctx.ui.confirm(
				`Write ${issue.root}/warden.config.ts (project "${issue.name}", bundle id ${id}) so warden dev starts without asking Expo for the config?`,
				true
			);
			if (answer !== true) return ok(false);
			const file = join(issue.root, "warden.config.ts");
			write(file, wardenConfigSource({ name: issue.name, bundleId: issue.bundleId }, { e2e: false }));
			await formatWithPrettier(ctx, issue.root, file);
			success(ctx, `warden dev: wrote ${file}`);
			return ok(true);
		}
	}
}
