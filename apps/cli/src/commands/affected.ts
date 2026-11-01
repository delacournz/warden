import { join } from "node:path";
import { type Affected, type AffectedInput, affectedService } from "@delacour/warden-core/affected/affected";
import type { Reason, Selection } from "@delacour/warden-core/affected/select";
import { batchJobs } from "@delacour/warden-core/batch/expand";
import { storeLocator } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import type { ChalkInstance } from "chalk";
import { parsePlatform } from "../claim-flags";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";

export type AffectedOpts = {
	base?: string;
	platform?: string;
	files?: string;
	json?: true;
	explain?: true;
	requiredOnly?: true;
	strict?: true;
	/** `warden e2e --all` */
	all?: true;
	/** `warden e2e --specs`: comma-separated ids / globs */
	specs?: string;
};

export class AffectedCommand extends CliCommand {
	override readonly name = "affected";
	override readonly group = "Run";
	override readonly summary = "list the e2e specs a change needs (git diff vs base → import graph → specs)";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.argument("[suite]", "e2e.<suite> in warden.config.ts (optional with one suite)")
			.option("--base <ref>", "compare against merge-base with this ref (default: the suite's base, main)")
			.option("--platform <platform>", "ios | android (default: the suite's platform, else both)")
			.option("--files <list>", "comma-separated changed files (relative to cwd) instead of git")
			.option("--required-only", "only specs with required: true")
			.option("--explain", "show why each spec was selected")
			.option("--strict", "exit 3 when a changed file reaches no spec")
			.option("--json", "machine-readable output")
			.addHelpText(
				"after",
				"\nExamples:\n  warden affected mobile --base origin/main --explain\n  warden affected mobile --platform ios | warden batch ios --jobs-from - -- <runner> {job}"
			)
			.action(async (suite, opts) => done(await this.affected(ctx, suite, opts)));
	}

	/** Option values → `affectedService.compute` input; parsed imports are cached under `$WARDEN_HOME/affected`. */
	affectedInput(ctx: CommandContext, suite: string | undefined, opts: AffectedOpts): Result<AffectedInput> {
		if (opts.all && opts.specs !== undefined) return resultFactory.err("--all and --specs are exclusive");
		if ((opts.all || opts.specs !== undefined) && opts.files !== undefined)
			return resultFactory.err("--all / --specs select without a diff — drop --files");
		let platform: Platform | undefined;
		if (opts.platform !== undefined) {
			const parsed = parsePlatform(opts.platform);
			if (!parsed.success) return parsed;
			platform = parsed.data;
		}
		return resultFactory.ok({
			exec: ctx.exec,
			cwd: ctx.cwd,
			git: ctx.git,
			env: ctx.env,
			cacheDir: join(storeLocator.wardenHome(ctx.env), "affected"),
			...(suite !== undefined ? { suite } : {}),
			...(opts.base !== undefined ? { base: opts.base } : {}),
			...(platform ? { platform } : {}),
			...(opts.files !== undefined ? { files: batchJobs.parseList(opts.files) } : {}),
			...(opts.specs !== undefined
				? { only: { mode: "specs" as const, patterns: batchJobs.parseList(opts.specs) } }
				: opts.all
					? { only: { mode: "all" as const } }
					: {}),
		});
	}

	/** Selected specs, `--required-only` applied. */
	selectedSpecs(selection: Selection, requiredOnly: boolean) {
		return selection.selected.filter((f) => !requiredOnly || f.required);
	}

	private describeReason(reason: Reason, color: ChalkInstance): string[] {
		switch (reason.kind) {
			case "run-all":
				return [`run-all  ${reason.file} ${color.dim(`(${reason.pattern})`)}`];
			case "path":
				return [`path     ${reason.file} ${color.dim(`(${reason.pattern})`)}`];
			case "import":
				return [`import   ${reason.file}`, color.dim(`         ${reason.chain.join(" → ")}`)];
			case "spec-file":
				return [`spec     ${reason.file}`];
			case "always":
				return [`always   ${color.dim(reason.pattern)}`];
			case "unmapped":
				return [`unmapped ${color.dim("(no entries / paths — runs every time)")}`];
			case "all":
				return [`all      ${color.dim("(--all)")}`];
			case "requested":
				return [`specs    ${color.dim(`(--specs ${reason.pattern})`)}`];
			case "unmatched":
				return [`unmatched ${reason.file} ${color.dim("(reached no spec — unmatched: run-all)")}`];
		}
	}

	/** What the selection was made from. */
	private selectionSource(affected: Affected): string {
		const origin = affected.suite.source === "overlay" ? ", overlay config" : "";
		if (affected.suite.implicit) return `default suite${origin}`;
		return `${affected.base === undefined ? "--files" : `base ${affected.base}`}${origin}`;
	}

	/** `--explain`: per platform, every selected spec with why, then what was skipped / unreached. */
	explain(affected: Affected, requiredOnly: boolean, color: ChalkInstance): string {
		const lines: string[] = [];
		const source = this.selectionSource(affected);
		for (const selection of affected.selections) {
			const specs = this.selectedSpecs(selection, requiredOnly);
			const total = selection.selected.length + selection.skipped.length;
			lines.push(
				color.bold(`${selection.platform}  ${specs.length} of ${total} spec(s)`) +
					color.dim(`  (${source}, ${affected.changes.length} changed file(s))`)
			);
			for (const spec of specs) {
				lines.push(`  ${color.green("●")} ${spec.id}  ${spec.required ? "required" : color.dim("optional")}`);
				for (const reason of spec.reasons) lines.push(...this.describeReason(reason, color).map((l) => `      ${l}`));
			}
			if (selection.skipped.length > 0) lines.push(color.dim(`  skipped: ${selection.skipped.join(", ")}`));
			if (selection.unreached.length > 0)
				lines.push(color.yellow(`  reached no spec: ${selection.unreached.join(", ")}`));
		}
		return lines.join("\n");
	}

	private jsonDoc(affected: Affected, requiredOnly: boolean) {
		return {
			suite: affected.suite.name,
			source: affected.suite.source,
			...(affected.base !== undefined ? { base: affected.base } : {}),
			changes: affected.changes,
			platforms: affected.selections.map((s) => ({ ...s, selected: this.selectedSpecs(s, requiredOnly) })),
			warnings: affected.warnings,
		};
	}

	async runAffected(ctx: CommandContext, suite: string | undefined, opts: AffectedOpts): AsyncResult<Affected> {
		const input = this.affectedInput(ctx, suite, opts);
		return input.success ? affectedService.compute(input.data) : input;
	}

	/**
	 * `warden affected [suite]`: git changes vs `--base` → the e2e specs that must run. Default output is
	 * one spec id per line (ready for `jobsFrom`); `--explain` shows why; `--strict` exits 3 when a
	 * changed file reached no spec.
	 */
	private async affected(ctx: CommandContext, suite: string | undefined, opts: AffectedOpts): Promise<number> {
		const { color } = ctx.ui;
		const result = await this.runAffected(ctx, suite, opts);
		if (!result.success) {
			output.reportError(ctx, "affected", result.error);
			return 1;
		}
		const data = result.data;
		const requiredOnly = opts.requiredOnly === true;
		const warnings = [
			...data.warnings,
			...data.selections.flatMap((s) => s.warnings.map((w) => `${s.platform}: ${w}`)),
		];
		for (const warning of warnings) output.warn(ctx, `warden affected: ${warning}`);
		if (opts.json) ctx.out(JSON.stringify(this.jsonDoc(data, requiredOnly), null, 2));
		else if (opts.explain) ctx.out(this.explain(data, requiredOnly, color));
		else {
			const ids = new Set(data.selections.flatMap((s) => this.selectedSpecs(s, requiredOnly).map((f) => f.id)));
			for (const id of ids) ctx.out(id);
		}
		const unreached = data.selections.some((s) => s.unreached.length > 0);
		return opts.strict && unreached ? 3 : 0;
	}
}

export const affectedCli = new AffectedCommand();
export const affectedCommand = affectedCli.definition();
