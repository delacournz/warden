import { join } from "node:path";
import { type Affected, type AffectedInput, computeAffected } from "@warden/core/affected/affected";
import type { Reason, Selection } from "@warden/core/affected/select";
import { parseJobList } from "@warden/core/batch/expand";
import { wardenHome } from "@warden/core/store";
import type { Platform } from "@warden/core/types";
import { type AsyncResult, ok, type Result } from "@warden/types/result";
import type { ChalkInstance } from "chalk";
import { parsePlatform } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";

export type AffectedOpts = {
	base?: string;
	platform?: string;
	files?: string;
	json?: true;
	explain?: true;
	requiredOnly?: true;
	strict?: true;
};

/** Option values → `computeAffected` input; parsed imports are cached under `$WARDEN_HOME/affected`. */
export function affectedInput(
	ctx: CommandContext,
	suite: string | undefined,
	opts: AffectedOpts
): Result<AffectedInput> {
	let platform: Platform | undefined;
	if (opts.platform !== undefined) {
		const parsed = parsePlatform(opts.platform);
		if (!parsed.success) return parsed;
		platform = parsed.data;
	}
	return ok({
		exec: ctx.exec,
		cwd: ctx.cwd,
		cacheDir: join(wardenHome(ctx.env), "affected"),
		...(suite !== undefined ? { suite } : {}),
		...(opts.base !== undefined ? { base: opts.base } : {}),
		...(platform ? { platform } : {}),
		...(opts.files !== undefined ? { files: parseJobList(opts.files) } : {}),
	});
}

/** Selected flows, `--required-only` applied. */
export function selectedFlows(selection: Selection, requiredOnly: boolean) {
	return selection.selected.filter((f) => !requiredOnly || f.required);
}

function describeReason(reason: Reason, color: ChalkInstance): string[] {
	switch (reason.kind) {
		case "run-all":
			return [`run-all  ${reason.file} ${color.dim(`(${reason.pattern})`)}`];
		case "path":
			return [`path     ${reason.file} ${color.dim(`(${reason.pattern})`)}`];
		case "import":
			return [`import   ${reason.file}`, color.dim(`         ${reason.chain.join(" → ")}`)];
		case "flow-file":
			return [`flow     ${reason.file}`];
		case "always":
			return [`always   ${color.dim(reason.pattern)}`];
		case "unmapped":
			return [`unmapped ${color.dim("(no entries / paths — runs every time)")}`];
	}
}

/** `--explain`: per platform, every selected flow with why, then what was skipped / unreached. */
export function explain(affected: Affected, requiredOnly: boolean, color: ChalkInstance): string {
	const lines: string[] = [];
	const source = affected.base === undefined ? "--files" : `base ${affected.base}`;
	for (const selection of affected.selections) {
		const flows = selectedFlows(selection, requiredOnly);
		const total = selection.selected.length + selection.skipped.length;
		lines.push(
			color.bold(`${selection.platform}  ${flows.length} of ${total} flow(s)`) +
				color.dim(`  (${source}, ${affected.changes.length} changed file(s))`)
		);
		for (const flow of flows) {
			lines.push(`  ${color.green("●")} ${flow.id}  ${flow.required ? "required" : color.dim("optional")}`);
			for (const reason of flow.reasons) lines.push(...describeReason(reason, color).map((l) => `      ${l}`));
		}
		if (selection.skipped.length > 0) lines.push(color.dim(`  skipped: ${selection.skipped.join(", ")}`));
		if (selection.unreached.length > 0)
			lines.push(color.yellow(`  reached no flow: ${selection.unreached.join(", ")}`));
	}
	return lines.join("\n");
}

function jsonDoc(affected: Affected, requiredOnly: boolean) {
	return {
		suite: affected.suite.name,
		...(affected.base !== undefined ? { base: affected.base } : {}),
		changes: affected.changes,
		platforms: affected.selections.map((s) => ({ ...s, selected: selectedFlows(s, requiredOnly) })),
		warnings: affected.warnings,
	};
}

export async function runAffected(
	ctx: CommandContext,
	suite: string | undefined,
	opts: AffectedOpts
): AsyncResult<Affected> {
	const input = affectedInput(ctx, suite, opts);
	return input.success ? computeAffected(input.data) : input;
}

/**
 * `warden affected [suite]`: git changes vs `--base` → the e2e flows that must run. Default output is
 * one flow id per line (ready for `jobsFrom`); `--explain` shows why; `--strict` exits 3 when a
 * changed file reached no flow.
 */
async function affected(ctx: CommandContext, suite: string | undefined, opts: AffectedOpts): Promise<number> {
	const { color } = ctx.ui;
	const result = await runAffected(ctx, suite, opts);
	if (!result.success) {
		ctx.err(color.red(`warden affected: ${result.error}`));
		return 1;
	}
	const data = result.data;
	const requiredOnly = opts.requiredOnly === true;
	const warnings = [...data.warnings, ...data.selections.flatMap((s) => s.warnings.map((w) => `${s.platform}: ${w}`))];
	for (const warning of warnings) ctx.err(color.yellow(`warden affected: ${warning}`));
	if (opts.json) ctx.out(JSON.stringify(jsonDoc(data, requiredOnly), null, 2));
	else if (opts.explain) ctx.out(explain(data, requiredOnly, color));
	else {
		const ids = new Set(data.selections.flatMap((s) => selectedFlows(s, requiredOnly).map((f) => f.id)));
		for (const id of ids) ctx.out(id);
	}
	const unreached = data.selections.some((s) => s.unreached.length > 0);
	return opts.strict && unreached ? 3 : 0;
}

export const affectedCommand = defineCommand({
	name: "affected",
	summary: "list the e2e flows a change needs (git diff vs base → import graph → flows)",
	register: (cmd, ctx, done) => {
		cmd
			.argument("[suite]", "e2e.<suite> in warden.config.json (optional with one suite)")
			.option("--base <ref>", "compare against merge-base with this ref (default: the suite's base, main)")
			.option("--platform <platform>", "ios | android (default: the suite's platform, else both)")
			.option("--files <list>", "comma-separated changed files (relative to cwd) instead of git")
			.option("--required-only", "only flows with required: true")
			.option("--explain", "show why each flow was selected")
			.option("--strict", "exit 3 when a changed file reaches no flow")
			.option("--json", "machine-readable output")
			.addHelpText(
				"after",
				"\nExamples:\n  warden affected mobile --base origin/main --explain\n  warden batch ios --jobs-from - -- <runner> {job} < <(warden affected mobile --platform ios)"
			)
			.action(async (suite, opts) => done(await affected(ctx, suite, opts)));
	},
});
