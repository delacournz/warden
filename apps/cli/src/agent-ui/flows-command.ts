import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { exportFlow } from "@delacour/warden-e2e/flows/export";
import type { Flow } from "@delacour/warden-e2e/flows/flow.schema";
import { createFlowFile, readFlowFile, serializeFlow, writeFileAtomic } from "@delacour/warden-e2e/flows/record";
import { type ActError, type ReplayDeps, replayFlow, type StepEvent } from "@delacour/warden-e2e/flows/replay";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { parseSettle } from "./act";
import { fromDriver, type UiDeps } from "./driver";
import { flowActors } from "./flow-actors";
import { reportError, type UiError, uiError } from "./output";
import { runUi, type UiOptionValues, withUiOptions } from "./run";
import { DEFAULT_SETTLE_BUDGET_MS, takeSnapshot } from "./snapshot";
import { readState, writeState } from "./state";

/** Where recordings go unless `--out` says otherwise, relative to the working directory. */
export const FLOWS_DIR = ".warden-ui";

const slug = (name: string): string =>
	name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");

function loadFlow(ctx: CommandContext, file: string): Result<{ path: string; flow: Flow }, UiError> {
	const path = resolve(ctx.cwd, file);
	const read = readFlowFile(path);
	if (!read.success) {
		return {
			success: false,
			error: uiError("failed", `${file}: ${read.error.message}`, { details: { code: read.error.code } }),
		};
	}
	return ok({ path, flow: read.data });
}

// ---- record ------------------------------------------------------------------------------------------------------

export type RecordStartOptionValues = UiOptionValues & { out?: string };

/** `warden ui record start <name> [--out file]`: from now on every action is appended to `<cwd>/.warden-ui/<name>.flow.json`. */
export function uiRecordStart(
	ctx: CommandContext,
	deps: UiDeps,
	name: string,
	opts: RecordStartOptionValues
): Promise<number> {
	return runUi(ctx, deps, "record start", opts, async (device, env) => {
		const flowName = name.trim();
		if (slug(flowName) === "") {
			return {
				success: false,
				error: uiError("usage", "record start needs a name", { hint: "warden ui record start <name>" }),
			};
		}
		const state = readState(ctx, device.udid);
		if (state.recording) {
			return {
				success: false,
				error: uiError("usage", `already recording "${state.recording.name}"`, {
					hint: "run `warden ui record stop` first",
				}),
			};
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const health = fromDriver(await driver.data.health());
		if (!health.success) return health;

		const file =
			opts.out === undefined ? join(ctx.cwd, FLOWS_DIR, `${slug(flowName)}.flow.json`) : resolve(ctx.cwd, opts.out);
		const { width, height, scale } = health.data.screen;
		const created = createFlowFile(file, {
			name: flowName,
			createdAt: ctx.now(),
			recordedOn: {
				platform: device.platform,
				device: device.name ?? device.udid,
				screen: { width, height, scale },
				...(state.app !== undefined ? { app: state.app } : {}),
				...(state.metroUrl !== undefined ? { metro: state.metroUrl } : {}),
			},
		});
		if (!created.success) {
			return {
				success: false,
				error: uiError("usage", created.error.message, { hint: "pick another name or --out, or delete the file" }),
			};
		}
		writeState(ctx, device.udid, { ...state, recording: { file, name: flowName, startedAt: ctx.now() } });
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: { name: flowName, file },
			text: `recording "${flowName}" to ${file}\nevery warden ui action is appended; \`record stop\` ends it (--no-record skips one step)`,
		});
	});
}

/** `warden ui record stop`: end the recording and report how many steps it holds. */
export function uiRecordStop(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record stop", opts, async (device) => {
		const state = readState(ctx, device.udid);
		const { recording, ...rest } = state;
		if (!recording) {
			return { success: false, error: uiError("usage", "not recording", { hint: "warden ui record start <name>" }) };
		}
		const flow = readFlowFile(recording.file);
		writeState(ctx, device.udid, rest);
		const steps = flow.success ? flow.data.steps.length : 0;
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			result: { name: recording.name, file: recording.file, steps },
			text: `stopped "${recording.name}": ${steps} step${steps === 1 ? "" : "s"} in ${recording.file}`,
			warnings: flow.success ? [] : [`could not read ${recording.file}: ${flow.error.message}`],
		});
	});
}

/** `warden ui record status`. */
export function uiRecordStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record status", opts, async (device) => {
		const { recording } = readState(ctx, device.udid);
		const info = { udid: device.udid, platform: device.platform, name: device.name };
		if (!recording) return ok({ device: info, result: { recording: null }, text: "not recording" });
		const flow = readFlowFile(recording.file);
		const steps = flow.success ? flow.data.steps.length : 0;
		return ok({
			device: info,
			result: { recording: { ...recording, steps } },
			text: `recording "${recording.name}": ${steps} step${steps === 1 ? "" : "s"} in ${recording.file}`,
		});
	});
}

// ---- replay ------------------------------------------------------------------------------------------------------

export type ReplayOptionValues = UiOptionValues & {
	from?: string;
	updateSnapshots?: true;
	/** `--settle` alone = true, `--settle 5000` = "5000": settle after every step, not only the recorded ones */
	settle?: true | string;
};

function parseFrom(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return ok(0);
	if (!/^\d+$/.test(raw))
		return { success: false, error: uiError("usage", `--from must be a step number, got "${raw}"`) };
	return ok(Number(raw));
}

const asActError = (error: { code: string; message: string }): ActError => ({
	code: error.code,
	message: error.message,
});

/**
 * `warden ui replay <file> [--from i] [--update-snapshots] [--settle [ms]]`: re-run a recorded flow. Each step's
 * selector chain is resolved on a fresh snapshot and checked against where it was recorded; a screen that no longer
 * matches is a `replay_divergence` (exit 1, step index + screen excerpt). A changed screen hash is only a drift
 * warning. The file is rewritten only with `--update-snapshots`.
 */
export function uiReplay(ctx: CommandContext, deps: UiDeps, file: string, opts: ReplayOptionValues): Promise<number> {
	return runUi(ctx, deps, "replay", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const from = parseFrom(opts.from);
		if (!from.success) return from;
		const loaded = loadFlow(ctx, file);
		if (!loaded.success) return loaded;
		const { path } = loaded.data;
		const flow: Flow =
			settle.data === undefined
				? loaded.data.flow
				: {
						...loaded.data.flow,
						steps: loaded.data.flow.steps.map((step) =>
							step.settle ? step : { ...step, settle: { timeoutMs: settle.data ?? DEFAULT_SETTLE_BUDGET_MS } }
						),
					};
		const driver = await env.driver();
		if (!driver.success) return driver;

		const events: StepEvent[] = [];
		const { color } = ctx.ui;
		const replayDeps: ReplayDeps = {
			driver: driver.data,
			snapshot: async () => {
				const taken = await driver.data.snapshot();
				return taken.success ? taken : { success: false, error: asActError(taken.error) };
			},
			act: flowActors(ctx, deps, device, driver.data, env.timeoutMs),
			settle: async (options) => {
				const budgetMs = options.timeoutMs ?? DEFAULT_SETTLE_BUDGET_MS;
				const taken = await takeSnapshot(ctx, deps, driver.data, device.udid, {
					interactiveOnly: true,
					all: false,
					settle: { budgetMs },
				});
				return taken.success ? taken : { success: false, error: asActError(taken.error) };
			},
			now: ctx.now,
			log: () => undefined,
			env: ctx.env,
			from: from.data,
			...(opts.updateSnapshots === true ? { updateSnapshots: true } : {}),
			onStep: (event) => {
				events.push(event);
				if (opts.json === true) return;
				const label = event.label === "" ? "" : ` ${event.label}`;
				ctx.out(`${color.green("✓")} ${event.step} ${event.kind}${label} ${color.dim(`(${event.ms} ms)`)}`);
				if (event.drift)
					ctx.out(
						color.yellow(
							`  drift: the screen differs from the recording (${event.drift.expected} → ${event.drift.actual})`
						)
					);
			},
		};
		const outcome = await replayFlow(flow, replayDeps);
		const info = { udid: device.udid, platform: device.platform, name: device.name };

		if (outcome.status === "diverged") {
			if (opts.json !== true && outcome.snapshot !== "")
				ctx.err(`screen at step ${outcome.step}:\n${outcome.snapshot}`);
			return {
				success: false,
				error: uiError("replay_divergence", `step ${outcome.step} ${outcome.kind}: ${outcome.reason}`, {
					hint: "re-record the flow, or fix the app; --update-snapshots only refreshes recorded positions",
					details: {
						step: outcome.step,
						kind: outcome.kind,
						file: path,
						snapshot: outcome.snapshot,
						warnings: outcome.warnings,
					},
				}),
			};
		}
		if (outcome.status === "failed") {
			return {
				success: false,
				error: uiError(
					"failed",
					`step ${outcome.step} ${outcome.kind} failed: ${outcome.error.code}: ${outcome.error.message}`,
					{
						details: {
							step: outcome.step,
							kind: outcome.kind,
							file: path,
							error: outcome.error,
							warnings: outcome.warnings,
						},
					}
				),
			};
		}

		let updated = false;
		if (outcome.updated) {
			const before = serializeFlow(loaded.data.flow);
			const after = serializeFlow(outcome.updated);
			if (before !== after) {
				writeFileAtomic(path, after);
				updated = true;
			}
		}
		const drift = outcome.warnings.length;
		return ok({
			device: info,
			result: {
				file: path,
				status: "passed",
				steps: outcome.steps,
				drift: outcome.warnings,
				updated,
				events: events.map(({ step, kind, label, ms }) => ({ step, kind, target: label, ms })),
			},
			text: `replayed ${outcome.steps} step${outcome.steps === 1 ? "" : "s"} of "${flow.name}"${drift > 0 ? `, ${drift} drift warning${drift === 1 ? "" : "s"}` : ""}${updated ? `; updated ${path}` : ""}`,
			warnings: drift > 0 ? [`${drift} step${drift === 1 ? "" : "s"} saw a different screen than recorded`] : [],
		});
	});
}

// ---- export ------------------------------------------------------------------------------------------------------

export type ExportOptionValues = { to: string; ids?: string; force?: true; json?: true };

/** The `ids` export of an ids module (`export const ids = { key: "test-id" }`). */
async function loadIds(path: string): Promise<Result<Record<string, string>, string>> {
	try {
		// the query keeps a long-lived process from serving a stale module after we rewrote it
		const mod: unknown = await import(`${path}?t=${Date.now()}-${Math.random()}`);
		const ids = typeof mod === "object" && mod !== null && "ids" in mod ? mod.ids : undefined;
		const entries = typeof ids === "object" && ids !== null ? Object.entries(ids) : undefined;
		const strings = entries?.every((entry): entry is [string, string] => typeof entry[1] === "string");
		return entries && strings
			? ok(Object.fromEntries(entries))
			: err(`${path} must export \`ids\` as an object of strings`);
	} catch (error) {
		return err(`could not load ${path}: ${errorMessage(error)}`);
	}
}

function idsModuleText(ids: Record<string, string>): string {
	const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
	const rows = Object.entries(ids).map(([name, id]) => `\t${key(name)}: ${JSON.stringify(id)},`);
	return `export const ids = {\n${rows.join("\n")}\n} as const;\n`;
}

/** `./ids` for an ids file next to (or below) the spec, `../ids` above it; never with the `.ts`. */
function importPath(spec: string, idsFile: string): string {
	const rel = relative(dirname(spec), idsFile).replace(/\.[cm]?[jt]s$/, "");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * `warden ui export <file> --to e2e/<name>.e2e.ts [--ids <path>] [--force]`: write the flow as a spec for
 * `@delacour/warden-e2e`. Test ids go through an `ids` map: inline, or with `--ids` merged into that module
 * (existing keys are reused, new test ids get generated keys). Refuses to overwrite the spec without `--force`.
 */
export async function uiExport(ctx: CommandContext, file: string, opts: ExportOptionValues): Promise<number> {
	const report = { command: "export", json: opts.json === true, startedAt: ctx.now() };
	try {
		const loaded = loadFlow(ctx, file);
		if (!loaded.success) return reportError(ctx, report, loaded.error);
		const spec = resolve(ctx.cwd, opts.to);
		if (existsSync(spec) && opts.force !== true) {
			return reportError(
				ctx,
				report,
				uiError("usage", `${opts.to} already exists`, { hint: "pass --force to overwrite it" })
			);
		}
		const idsFile = opts.ids === undefined ? undefined : resolve(ctx.cwd, opts.ids);
		let known: Record<string, string> = {};
		if (idsFile !== undefined && existsSync(idsFile)) {
			const existing = await loadIds(idsFile);
			if (!existing.success) return reportError(ctx, report, uiError("failed", existing.error));
			known = existing.data;
		}
		const exported = exportFlow(loaded.data.flow, {
			ids: known,
			...(idsFile !== undefined ? { idsImport: importPath(spec, idsFile) } : {}),
		});
		mkdirSync(dirname(spec), { recursive: true });
		writeFileSync(spec, exported.spec);

		const added = Object.entries(exported.ids).filter(([key]) => !(key in known));
		const used = exported.spec.includes("ids.") || exported.spec.includes("ids[");
		if (idsFile !== undefined && added.length > 0 && used) {
			mkdirSync(dirname(idsFile), { recursive: true });
			writeFileSync(idsFile, idsModuleText(exported.ids));
		}
		const steps = loaded.data.flow.steps.length;
		const fixmes = (exported.spec.match(/FIXME/g) ?? []).length;
		const lines = [
			`wrote ${opts.to} (${steps} step${steps === 1 ? "" : "s"})`,
			...(idsFile !== undefined && added.length > 0 && used
				? [`updated ${opts.ids}`, ...added.map(([key, id]) => `  + ${key}: ${JSON.stringify(id)}`)]
				: []),
			...(fixmes > 0 ? [`${fixmes} FIXME to resolve before committing`] : []),
		];
		if (opts.json === true) {
			ctx.out(
				JSON.stringify({
					ok: true,
					command: "export",
					durationMs: Math.max(0, ctx.now() - report.startedAt),
					result: { spec, ids: idsFile ?? null, added: Object.fromEntries(added), steps, fixmes },
				})
			);
		} else {
			ctx.out(lines.join("\n"));
		}
		return 0;
	} catch (error) {
		return reportError(ctx, report, uiError("failed", errorMessage(error)));
	}
}

// ---- registration ------------------------------------------------------------------------------------------------

/** `record start|stop|status`, `replay` and `export` on `warden ui` (called once from `commands/ui.ts`). */
export function registerFlowCommands(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: UiDeps
): void {
	const record = cmd
		.command("record")
		.description("record warden ui actions as a replayable flow: start <name> | stop | status");
	withUiOptions(
		record
			.command("start")
			.description("start recording to .warden-ui/<name>.flow.json")
			.argument("<name>", "flow name")
			.option("--out <file>", "write the flow here instead")
	).action(async (name, opts) => done(await uiRecordStart(ctx, deps, name, opts)));
	withUiOptions(record.command("stop").description("stop recording and print the step count")).action(async (opts) =>
		done(await uiRecordStop(ctx, deps, opts))
	);
	withUiOptions(record.command("status").description("is a recording running, and how long is it")).action(
		async (opts) => done(await uiRecordStatus(ctx, deps, opts))
	);
	withUiOptions(
		cmd
			.command("replay")
			.description("re-run a recorded flow; a screen that no longer matches is a replay_divergence (exit 1)")
			.argument("<file>", "a .flow.json")
			.option("--from <i>", "start at this step index")
			.option("--update-snapshots", "rewrite the file with the positions and screen hashes seen now")
			.option("--settle [ms]", "settle after every step, not only the recorded ones (default budget 3000 ms)")
	).action(async (file, opts) => done(await uiReplay(ctx, deps, file, opts)));
	cmd
		.command("export")
		.description("write a recorded flow as an e2e spec for @delacour/warden-e2e")
		.argument("<file>", "a .flow.json")
		.requiredOption("--to <path>", "spec file to write, e.g. e2e/sign-in.e2e.ts")
		.option("--ids <path>", "ids module to merge test ids into (export const ids = { … })")
		.option("--force", "overwrite an existing spec")
		.option("--json", "machine-readable output: one JSON document on stdout")
		.action(async (file, opts) => done(await uiExport(ctx, file, opts)));
}
