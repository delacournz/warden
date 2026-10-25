import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Suite, SuiteError } from "@delacour/warden-core/affected/affected";
import {
	generateHelper,
	generateSpec,
	mergeIdsModule,
	parseIdsModule,
	type SharedSpecOptions,
} from "@delacour/warden-e2e/authoring/codegen";
import {
	appendStep,
	createJournal,
	deleteJournal,
	type JournalError,
	readJournal,
	undoSteps,
	writeFileAtomic,
} from "@delacour/warden-e2e/authoring/journal";
import { type LintFinding, lintRecording } from "@delacour/warden-e2e/authoring/lint";
import type { RecordedStep, Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import { recordingStatus, summarizeStep } from "@delacour/warden-e2e/authoring/status";
import { type AsyncResult, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { helpersWithGaps, type SpecConfig, specConfigFor, stepRoutes, visitedRoutes } from "./authoring-config";
import { loadHelperRoutes, saveHelperRoutes } from "./authoring-helper-routes";
import { findSharedSpecOptions, neededLaunch, reloadOptions, resolveOptionsRef } from "./authoring-options";
import { exportsName, type HelperRef, importPath, parseHelperRef, slugOf } from "./authoring-target";
import type { VerifyInput, VerifyReport } from "./authoring-verify";
import type { UiDevice } from "./device";
import { fromDriver, type UiDeps } from "./driver";
import { helperStatus } from "./helper";
import { type UiError, type UiSuccess, uiError } from "./output";
import { recordingFile, uiDir } from "./paths";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { positiveInt } from "./snapshot-command";
import { type RecordingPointer, readState, updateState } from "./state";

/**
 * `warden ui record`: the journal behind `start|note|undo|status|cancel|stop`, lazily imported by the
 * subcommand that runs (`authoring-register.ts`). The journal lives at `recordingFile` (`$WARDEN_HOME/ui/<udid>/
 * recording.json`); `state.json.recording` says where `stop` writes it. The journal outlives a failed verify:
 * it is removed only by a successful `stop` or `cancel`, so the agent can `undo`, fix the app and `stop` again.
 */

/** How targets are found and specs verified; tests inject both, the defaults use the suite config and the spec runner. */
export type AuthoringDeps = {
	/** `e2e.<name>` of the nearest warden config (undefined name: the only suite) */
	findSuite?: (ctx: CommandContext, name: string | undefined) => AsyncResult<Suite, SuiteError>;
	/** run the written spec once on the device */
	verify?: (ctx: CommandContext, input: VerifyInput) => AsyncResult<VerifyReport>;
};

async function defaultFindSuite(ctx: CommandContext, name: string | undefined): AsyncResult<Suite, SuiteError> {
	const { findSuite } = await import("@delacour/warden-core/affected/affected");
	return findSuite(ctx.exec, ctx.cwd, name, ctx.git, ctx.env);
}

async function defaultVerify(ctx: CommandContext, input: VerifyInput): AsyncResult<VerifyReport> {
	const [{ runVerify }, { defaultBatchDeps }] = await Promise.all([
		import("./authoring-verify"),
		import("../commands/batch"),
	]);
	return runVerify(ctx, defaultBatchDeps, input);
}

const failed = (
	code: UiError["code"],
	message: string,
	extra: { hint?: string; details?: Record<string, unknown> } = {}
): { success: false; error: UiError } => ({ success: false, error: uiError(code, message, extra) });

/** A journal failure as a `warden ui` error; the journal's own code rides along in `details.code`. */
function journalFailure(error: JournalError, hint?: string): { success: false; error: UiError } {
	return failed("failed", error.message, {
		details: { code: error.code },
		...(hint !== undefined ? { hint } : {}),
	});
}

const deviceOf = (device: UiDevice) => ({ udid: device.udid, platform: device.platform, name: device.name });

const targetPath = (target: RecordingPointer["target"]): string =>
	target.kind === "spec" ? target.path : `${target.path}#${target.fn}`;

function lintLines(lints: readonly LintFinding[], color: CommandContext["ui"]["color"]): string[] {
	return lints.flatMap((lint) => {
		const paint = lint.level === "error" ? color.red : color.yellow;
		return [
			`${paint(lint.level)} ${lint.code}${lint.step === null ? "" : ` (step ${lint.step})`}: ${lint.message}`,
			`  ${color.dim(lint.hint)}`,
		];
	});
}

// ---- start -------------------------------------------------------------------------------------------------------

export type RecordStartOptionValues = UiOptionValues & {
	to?: string;
	helper?: string;
	prerequisite?: string;
	ids?: string;
	options?: string;
	title?: string;
	suite?: string;
	overwrite?: true;
};

type Resolved = { target: RecordingPointer["target"]; suite?: string };

/** The spec a recording writes by default: `<suite specsDir>/<slug>.e2e.ts`, else `e2e/<slug>.e2e.ts` under the working directory. */
async function defaultSpecPath(
	ctx: CommandContext,
	authoring: AuthoringDeps,
	slug: string,
	suite: string | undefined
): Promise<Result<string, UiError>> {
	const found = await (authoring.findSuite ?? defaultFindSuite)(ctx, suite);
	if (found.success) return ok(resolve(found.data.configDir, found.data.config.specsDir, `${slug}.e2e.ts`));
	if (suite !== undefined || found.error.code === "several_suites") {
		return failed("usage", found.error.message, {
			hint: "pick one with --suite <name>, or give the spec path with --to",
		});
	}
	return ok(join(ctx.cwd, "e2e", `${slug}.e2e.ts`));
}

async function resolveTarget(
	ctx: CommandContext,
	authoring: AuthoringDeps,
	name: string,
	opts: RecordStartOptionValues
): Promise<Result<Resolved, UiError>> {
	if (opts.helper !== undefined && opts.to !== undefined) {
		return failed("usage", "--helper and --to are exclusive", {
			hint: "--to writes a spec, --helper adds a function to a helpers module",
		});
	}
	if (opts.prerequisite !== undefined && opts.helper === undefined) {
		return failed("usage", "--prerequisite only applies to --helper");
	}
	if (opts.helper !== undefined) {
		const ref: Result<HelperRef> = parseHelperRef(opts.helper);
		if (!ref.success) return failed("usage", ref.error);
		const path = resolve(ctx.cwd, ref.data.module);
		const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		if (existing !== undefined && exportsName(existing, ref.data.fn) && opts.overwrite !== true) {
			return failed("target_exists", `${ref.data.module} already exports ${ref.data.fn}`, {
				hint: "pick another function name, or pass --overwrite to replace it",
			});
		}
		return ok({
			target: {
				kind: "helper",
				path,
				fn: ref.data.fn,
				...(opts.prerequisite !== undefined ? { prerequisite: opts.prerequisite } : {}),
			},
			...(opts.suite !== undefined ? { suite: opts.suite } : {}),
		});
	}
	if (opts.to !== undefined && opts.suite === undefined) {
		const found = await (authoring.findSuite ?? defaultFindSuite)(ctx, undefined);
		if (!found.success && found.error.code === "several_suites") {
			return failed("usage", found.error.message, {
				hint: "pass --suite <name> now: `record use` and the verify run on that suite",
			});
		}
	}
	const path =
		opts.to !== undefined
			? ok(resolve(ctx.cwd, opts.to))
			: await defaultSpecPath(ctx, authoring, slugOf(name), opts.suite);
	if (!path.success) return path;
	if (existsSync(path.data) && opts.overwrite !== true) {
		return failed("target_exists", `${path.data} already exists`, {
			hint: "pass --overwrite to replace it, or --to <other spec>",
		});
	}
	return ok({ target: { kind: "spec", path: path.data }, ...(opts.suite !== undefined ? { suite: opts.suite } : {}) });
}

/** `--options <module#name>` as the pointer keeps it (absolute module); `none` switches the shared options off. */
function pinnedOptions(ctx: CommandContext, raw: string | undefined): Result<RecordingPointer["options"], UiError> {
	if (raw === undefined) return ok(undefined);
	if (raw.trim() === "none") return ok("none");
	const ref = resolveOptionsRef(raw, ctx.cwd);
	if (!ref.success) {
		return failed("usage", ref.error, {
			hint: "--options <module>#<name> names an exported object of test.use options, or `none` to pass none",
		});
	}
	return ok({ module: ref.data.module, name: ref.data.name });
}

/**
 * `warden ui record start <name>`: from now on every `warden ui` action (and `record note`) is appended to the device's
 * journal. `record stop` turns it into the spec (`--to`, default `<suite specsDir>/<name>.e2e.ts`) or, with
 * `--helper <module>#<fn>`, an exported function in a helpers module.
 */
export function uiRecordStart(
	ctx: CommandContext,
	deps: UiDeps,
	name: string,
	opts: RecordStartOptionValues
): Promise<number> {
	return runUi(ctx, deps, "record start", opts, async (device, env) => {
		const recordingName = name.trim();
		if (slugOf(recordingName) === "") {
			return failed("usage", "record start needs a name", { hint: 'warden ui record start "sign in"' });
		}
		const state = readState(ctx, device.udid);
		if (state.recording) {
			return failed("recording_active", `already recording "${state.recording.name}"`, {
				hint: "`warden ui record stop` writes it, `record cancel` throws it away",
			});
		}
		const resolved = await resolveTarget(ctx, deps.authoring ?? {}, recordingName, opts);
		if (!resolved.success) return resolved;
		const sharedOptions = pinnedOptions(ctx, opts.options);
		if (!sharedOptions.success) return sharedOptions;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const health = fromDriver(await driver.data.health());
		if (!health.success) return health;

		const journal = recordingFile(ctx, device.udid);
		// no pointer in state.json: a journal here belongs to a recording that died before it could be stopped
		if (existsSync(journal)) deleteJournal(journal);
		const { width, height, scale } = health.data.screen;
		const title = opts.title?.trim();
		const created = createJournal(journal, {
			name: recordingName,
			...(title ? { title } : {}),
			createdAt: ctx.now(),
			recordedOn: {
				platform: device.platform,
				device: device.name ?? device.udid,
				screen: { width, height, scale },
				...(state.app !== undefined ? { app: state.app } : {}),
				...(state.metroUrl !== undefined ? { metro: state.metroUrl } : {}),
			},
		});
		if (!created.success) return journalFailure(created.error);
		const ids = opts.ids === undefined ? undefined : resolve(ctx.cwd, opts.ids);
		updateState(ctx, device.udid, (current) => ({
			...current,
			recording: {
				name: recordingName,
				...(title ? { title } : {}),
				target: resolved.data.target,
				...(ids !== undefined ? { ids } : {}),
				...(resolved.data.suite !== undefined ? { suite: resolved.data.suite } : {}),
				...(sharedOptions.data !== undefined ? { options: sharedOptions.data } : {}),
				...(opts.overwrite === true ? { overwrite: true as const } : {}),
				startedAt: ctx.now(),
			},
		}));
		const { startRoute } = await import("./route-capture");
		await startRoute(ctx, deps, env, device);
		const { target } = resolved.data;
		return ok({
			device: deviceOf(device),
			result: {
				outcome: "started",
				name: recordingName,
				kind: target.kind,
				target: target.path,
				...(target.kind === "helper" ? { fn: target.fn } : {}),
				...(ids !== undefined ? { ids } : {}),
				journal,
			},
			text: [
				`recording "${recordingName}" → ${targetPath(target)}`,
				"every warden ui action is appended; `record note` marks a step, `record undo` drops one, `record stop` writes it (--no-record skips one action)",
			].join("\n"),
		});
	});
}

// ---- note / undo / status / cancel ---------------------------------------------------------------------------------

function activeRecording(
	ctx: CommandContext,
	udid: string
): Result<{ pointer: RecordingPointer; journal: string }, UiError> {
	const pointer = readState(ctx, udid).recording;
	if (!pointer) return failed("no_recording", "not recording", { hint: 'warden ui record start "<name>"' });
	return ok({ pointer, journal: recordingFile(ctx, udid) });
}

/** `warden ui record note "<text>"`: a user-visible step boundary; codegen writes it as a comment above the next step. */
export function uiRecordNote(ctx: CommandContext, deps: UiDeps, text: string, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record note", opts, async (device) => {
		const active = activeRecording(ctx, device.udid);
		if (!active.success) return active;
		const note = text.trim();
		if (note === "") return failed("usage", "record note needs some text");
		const appended = await appendStep(active.data.journal, { kind: "note", at: ctx.now(), text: note });
		if (!appended.success) return journalFailure(appended.error);
		return ok({
			device: deviceOf(device),
			result: { outcome: "noted", step: appended.data.i, text: note },
			text: `noted as step ${appended.data.i}`,
		});
	});
}

/** `warden ui record undo [n]`: drop the last `n` steps (default 1; notes count) from the journal. */
export function uiRecordUndo(
	ctx: CommandContext,
	deps: UiDeps,
	count: string | undefined,
	opts: UiOptionValues
): Promise<number> {
	return runUi(ctx, deps, "record undo", opts, async (device) => {
		const active = activeRecording(ctx, device.udid);
		if (!active.success) return active;
		const n = count === undefined ? ok(1) : positiveInt("undo count", count);
		if (!n.success) return n;
		const removed = await undoSteps(active.data.journal, n.data);
		if (!removed.success) {
			return journalFailure(
				removed.error,
				removed.error.code === "nothing_to_undo" ? "the recording is empty" : undefined
			);
		}
		const left = readJournal(active.data.journal);
		const steps = left.success ? left.data.steps.length : null;
		const summaries = removed.data.map((step) => ({ i: step.i, summary: summarizeStep(step) }));
		return ok({
			device: deviceOf(device),
			result: { outcome: "undone", removed: summaries, steps },
			text: [
				`removed ${summaries.length} step${summaries.length === 1 ? "" : "s"}${steps === null ? "" : `, ${steps} left`}`,
				...summaries.map((step) => `  - ${step.i} ${step.summary}`),
			].join("\n"),
		});
	});
}

/** `warden ui record status`: the target, the step count, the last five steps and the lints so far. */
export function uiRecordStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record status", opts, async (device) => {
		const pointer = readState(ctx, device.udid).recording;
		if (!pointer) {
			return ok({
				device: deviceOf(device),
				result: { outcome: "idle", recording: null },
				text: "not recording",
			});
		}
		const journal = readJournal(recordingFile(ctx, device.udid));
		if (!journal.success) return journalFailure(journal.error, "`warden ui record cancel` clears it");
		const status = recordingStatus(journal.data);
		const { color } = ctx.ui;
		return ok({
			device: deviceOf(device),
			result: {
				outcome: "recording",
				recording: {
					name: status.name,
					title: status.title ?? null,
					kind: pointer.target.kind,
					target: targetPath(pointer.target),
					startedAt: pointer.startedAt,
					steps: status.steps,
					last: status.last,
					lints: status.lints,
				},
			},
			text: [
				`recording "${status.name}" → ${targetPath(pointer.target)}: ${status.steps} step${status.steps === 1 ? "" : "s"}`,
				...status.last.map((step) => `  ${step.i} ${step.summary}`),
				...lintLines(status.lints, color),
			].join("\n"),
		});
	});
}

/** `warden ui record cancel`: throw the journal away. A spec already written by a failed `stop` is left in place. */
export function uiRecordCancel(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record cancel", opts, async (device) => {
		const active = activeRecording(ctx, device.udid);
		if (!active.success) return active;
		const { pointer, journal } = active.data;
		const read = readJournal(journal);
		const steps = read.success ? read.data.steps.length : null;
		if (existsSync(journal)) deleteJournal(journal);
		updateState(ctx, device.udid, ({ recording: _cancelled, ...rest }) => rest);
		const kept = pointer.wrote === true ? pointer.target.path : undefined;
		return ok({
			device: deviceOf(device),
			result: { outcome: "cancelled", name: pointer.name, steps, ...(kept !== undefined ? { kept } : {}) },
			text: `cancelled "${pointer.name}"${steps === null ? "" : ` (${steps} steps dropped)`}${kept !== undefined ? `; ${kept} was already written and is left in place` : ""}`,
		});
	});
}

// ---- stop --------------------------------------------------------------------------------------------------------

export type RecordStopOptionValues = UiOptionValues & {
	/** false = `--no-verify` */
	verify: boolean;
	overwrite?: true;
	suite?: string;
};

type Written = {
	file: string;
	fn?: string;
	replaced: boolean;
	source: string;
	ids: { file: string; added: Record<string, string> } | null;
};

function readIfExists(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function write(path: string, source: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomic(path, source);
}

/** What the generated spec's `test.use` says: the suite's shared options, and the launch the recording needs. */
type SpecShape = {
	specOptions?: SharedSpecOptions;
	launch: "none" | "fresh";
	/** several shared options objects fit and none was chosen */
	ambiguous?: string[];
};

const readIfPresent = (module: string): string | undefined =>
	existsSync(module) ? readFileSync(module, "utf8") : undefined;

/**
 * The shared `test.use` options and launch for a spec at `file`: the `--options` the recording started with (or
 * `none`), else the one object `findSharedSpecOptions` detects in the suite's specs directory (the specs dir of the
 * suite found, else the directory of the spec). The launch is `none` when the recording opens the app itself.
 */
async function specShapeFor(
	ctx: CommandContext,
	authoring: AuthoringDeps,
	pointer: RecordingPointer,
	recording: Recording,
	file: string,
	suiteName: string | undefined
): Promise<SpecShape> {
	const launch = neededLaunch(recording, readIfPresent);
	if (pointer.options === "none") return { launch };
	if (pointer.options !== undefined) return { launch, specOptions: reloadOptions(pointer.options) };
	const found = await (authoring.findSuite ?? defaultFindSuite)(ctx, suiteName);
	const specsDir = found.success ? resolve(found.data.configDir, found.data.config.specsDir) : dirname(file);
	const lookup = findSharedSpecOptions(specsDir);
	if (lookup.kind === "found") return { launch, specOptions: lookup.options };
	return lookup.kind === "ambiguous" ? { launch, ambiguous: lookup.names } : { launch };
}

/** Generate the spec or helper for `recording` and write it (and the merged ids module); nothing is written when generation fails. */
function writeTarget(
	pointer: RecordingPointer,
	recording: Recording,
	overwrite: boolean,
	shape: SpecShape
): Result<Written, UiError> {
	const { target } = pointer;
	const idsExisting = pointer.ids === undefined ? undefined : readIfExists(pointer.ids);
	const known = idsExisting === undefined ? {} : parseIdsModule(idsExisting);
	const idsImport = pointer.ids === undefined ? undefined : importPath(target.path, pointer.ids);
	const replace = overwrite || pointer.wrote === true;

	let source: string;
	let ids: Record<string, string>;
	let replaced = false;
	if (target.kind === "spec") {
		const generated = generateSpec(recording, {
			ids: known,
			file: target.path,
			launch: shape.launch,
			...(shape.specOptions !== undefined ? { specOptions: shape.specOptions } : {}),
			...(idsImport !== undefined ? { idsImport, idsMerged: true } : {}),
		});
		source = generated.source;
		ids = generated.ids;
	} else {
		const generated = generateHelper(recording, {
			name: target.fn,
			ids: known,
			file: target.path,
			existing: readIfExists(target.path),
			force: replace,
			...(target.prerequisite !== undefined ? { prerequisite: target.prerequisite } : {}),
			...(idsImport !== undefined ? { idsImport } : {}),
		});
		if (!generated.success) {
			return failed(generated.error.code === "helper_exists" ? "target_exists" : "failed", generated.error.message, {
				details: { code: generated.error.code },
				hint:
					generated.error.code === "helper_exists" ? "pass --overwrite to replace it" : "pick another function name",
			});
		}
		({ source, ids, replaced } = generated.data);
	}
	let idsWrite: { text: string } | undefined;
	if (pointer.ids !== undefined) {
		const merged = mergeIdsModule(idsExisting, ids);
		if (!merged.success) {
			return failed("failed", `${pointer.ids}: ${merged.error.message}`, { details: { code: merged.error.code } });
		}
		if (merged.data !== idsExisting) idsWrite = { text: merged.data };
	}
	write(target.path, source);
	if (pointer.ids !== undefined && idsWrite) write(pointer.ids, idsWrite.text);
	const added = Object.fromEntries(Object.entries(ids).filter(([key]) => !(key in known)));
	return ok({
		file: target.path,
		...(target.kind === "helper" ? { fn: target.fn } : {}),
		replaced,
		source,
		ids: pointer.ids === undefined ? null : { file: pointer.ids, added: idsWrite ? added : {} },
	});
}

/**
 * The `specs.<id>` proposal for a written spec (null for a helper): the routes the recording visited, mapped to files
 * under the suite's `routerRoot`. The app is asked once more for the route it ended on. A missing suite only costs
 * the mapping; nothing here fails the stop.
 */
async function configFor(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice,
	pointer: RecordingPointer,
	recording: Recording,
	file: string,
	suiteName: string | undefined
): Promise<SpecConfig> {
	const { readCurrentRoute } = await import("./route-capture");
	const [final, found, { routeEntries }, { specIdOf }] = await Promise.all([
		readCurrentRoute(ctx, deps, env, device),
		(deps.authoring?.findSuite ?? defaultFindSuite)(ctx, suiteName),
		import("@delacour/warden-core/affected/routes"),
		import("@delacour/warden-core/affected/specs"),
	]);
	const routes = visitedRoutes(pointer.routes?.initial, stepRoutes(recording.steps), final);
	return specConfigFor({
		file,
		routes,
		suite: found.success ? found.data : undefined,
		devicePlatform: device.platform,
		helperGaps: helpersWithGaps(recording.steps),
		resolveRoutes: routeEntries,
		specId: specIdOf,
	});
}

/**
 * A helper recording's routes (its start, its steps, where it ended), saved for the `record use` of that helper in a
 * later recording; a helper recorded on a release build saves an empty list.
 */
async function rememberHelperRoutes(
	ctx: CommandContext,
	deps: UiDeps,
	env: UiRunEnv,
	device: UiDevice,
	pointer: RecordingPointer,
	recording: Recording
): Promise<void> {
	const { target } = pointer;
	if (target.kind !== "helper") return;
	const { readCurrentRoute } = await import("./route-capture");
	const final = await readCurrentRoute(ctx, deps, env, device);
	saveHelperRoutes(
		ctx,
		target.path,
		target.fn,
		visitedRoutes(pointer.routes?.initial, stepRoutes(recording.steps), final)
	);
}

/** What `test.use` the written spec got, in words. */
function shapeLines(shape: SpecShape, file: string): string[] {
	const { specOptions, launch, ambiguous } = shape;
	return [
		...(specOptions
			? [
					`passes the shared options ${specOptions.name} from ${relative(dirname(file), specOptions.module)} to test.use`,
				]
			: []),
		...(launch === "none"
			? ["launch none: the recording opens the app itself, so the runner does not launch it first"]
			: []),
		...(ambiguous
			? [
					`note: several shared spec options fit (${ambiguous.join(", ")}); none was passed. \`record start --options <module>#<name>\` picks one`,
				]
			: []),
	];
}

function configLines(config: SpecConfig, suite: string | undefined): string[] {
	return [
		`add to ${suite === undefined ? "the suite" : `e2e.${suite}`} in warden.config.ts:`,
		...config.snippet.split("\n").map((line) => `  ${line}`),
		...config.hints.map((hint) => `  note: ${hint}`),
	];
}

const fixmesIn = (source: string): number => (source.match(/^\s*\/\/ FIXME:/gm) ?? []).length;

/**
 * `warden ui record stop`: write the spec (or helper), merge the ids module, print the lints and, unless `--no-verify`
 * (or a helper), run the spec once on this device. A failed verify exits 1 and keeps both the file and the journal:
 * `record undo` / fix the app / `record stop` again, or `record cancel`. The journal is removed only on success.
 */
export function uiRecordStop(ctx: CommandContext, deps: UiDeps, opts: RecordStopOptionValues): Promise<number> {
	return runUi(ctx, deps, "record stop", opts, async (device, env) => {
		const active = activeRecording(ctx, device.udid);
		if (!active.success) return active;
		const { pointer, journal } = active.data;
		const read = readJournal(journal);
		if (!read.success) return journalFailure(read.error, "`warden ui record cancel` clears it");
		const recording = read.data;
		const lints = lintRecording(recording);
		if (lints.some((lint) => lint.code === "empty_recording")) {
			return failed("empty_recording", "the recording has no steps", {
				hint: "drive the app with warden ui actions after `record start`, or `record cancel`",
			});
		}
		const { target } = pointer;
		if (
			target.kind === "spec" &&
			existsSync(target.path) &&
			pointer.wrote !== true &&
			opts.overwrite !== true &&
			pointer.overwrite !== true
		) {
			return failed("target_exists", `${target.path} already exists`, { hint: "pass --overwrite to replace it" });
		}
		const shape: SpecShape =
			target.kind === "spec"
				? await specShapeFor(ctx, deps.authoring ?? {}, pointer, recording, target.path, opts.suite ?? pointer.suite)
				: { launch: "fresh" };
		const written = writeTarget(pointer, recording, opts.overwrite === true || pointer.overwrite === true, shape);
		if (!written.success) return written;
		updateState(ctx, device.udid, (current) =>
			current.recording ? { ...current, recording: { ...current.recording, wrote: true } } : current
		);
		const steps = recording.steps.length;
		const fixmes = fixmesIn(written.data.source);
		const config =
			target.kind === "spec"
				? await configFor(ctx, deps, env, device, pointer, recording, target.path, opts.suite ?? pointer.suite)
				: null;
		if (target.kind === "helper") await rememberHelperRoutes(ctx, deps, env, device, pointer, recording);
		const summary = {
			kind: target.kind,
			name: recording.name,
			file: written.data.file,
			...(written.data.fn !== undefined ? { fn: written.data.fn, replaced: written.data.replaced } : {}),
			steps,
			ids: written.data.ids,
			lints,
			fixmes,
			config,
			...(target.kind === "spec"
				? {
						options: shape.specOptions ? { module: shape.specOptions.module, name: shape.specOptions.name } : null,
						launch: shape.launch,
					}
				: {}),
		};
		const { color } = ctx.ui;
		const wrote = [
			`wrote ${written.data.file}${written.data.fn !== undefined ? ` (${written.data.fn}${written.data.replaced ? ", replaced" : ""})` : ""}: ${steps} step${steps === 1 ? "" : "s"}`,
			...(written.data.ids
				? Object.keys(written.data.ids.added).length > 0
					? [
							`updated ${written.data.ids.file}`,
							...Object.entries(written.data.ids.added).map(([key, id]) => `  + ${key}: ${JSON.stringify(id)}`),
						]
					: []
				: []),
			...(fixmes > 0 ? [`${fixmes} FIXME to resolve before committing`] : []),
			...shapeLines(shape, target.path),
			...lintLines(lints, color),
			...(config ? configLines(config, config.suite) : []),
		];

		const finish = (verify: Record<string, unknown>, lines: string[], outcome: "verified" | "written"): UiSuccess => {
			deleteJournal(journal);
			updateState(ctx, device.udid, ({ recording: _done, ...rest }) => rest);
			return {
				device: deviceOf(device),
				result: { outcome, ...summary, verify },
				text: [...wrote, ...lines].join("\n"),
			};
		};

		if (target.kind === "helper") {
			return ok(
				finish(
					{ status: "skipped", reason: "helper" },
					[
						"verify skipped: a helper is not a spec — run a spec that calls it (`warden e2e <suite> --specs <id>`) to check it",
					],
					"written"
				)
			);
		}
		if (opts.verify === false) {
			return ok(finish({ status: "skipped", reason: "flag" }, ["verify skipped (--no-verify)"], "written"));
		}
		return verifyWritten(ctx, deps, device, pointer, opts, summary, wrote, finish);
	});
}

/** A spec run as `--json` reports it (`verify`) plus every file worth reading when it failed. */
function describeRun(report: VerifyReport): { verify: Record<string, unknown>; evidence: string[] } {
	return {
		evidence: [report.results, report.log, ...report.tests.flatMap((test) => test.evidence)],
		verify: {
			status: report.passed ? "passed" : "failed",
			exitCode: report.exitCode,
			outDir: report.outDir,
			log: report.log,
			results: report.results,
			tests: report.tests,
		},
	};
}

function printFailures(ctx: CommandContext, report: VerifyReport, evidence: readonly string[]): void {
	for (const test of report.tests.filter((candidate) => candidate.status !== "passed")) {
		ctx.err(ctx.ui.color.red(`✗ ${test.title}${test.error ? `: ${test.error.split("\n")[0]}` : ""}`));
	}
	for (const path of evidence) ctx.err(`  ${ctx.ui.color.dim(path)}`);
}

type Finish = (verify: Record<string, unknown>, lines: string[], outcome: "verified" | "written") => UiSuccess;

/** Run the written spec once; success finishes the recording, anything else keeps it. */
async function verifyWritten(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	pointer: RecordingPointer,
	opts: RecordStopOptionValues,
	summary: Record<string, unknown>,
	wrote: string[],
	finish: Finish
): Promise<Result<UiSuccess, UiError>> {
	const authoring = deps.authoring ?? {};
	const keep = (error: UiError): { success: false; error: UiError } => {
		if (opts.json !== true) for (const line of wrote) ctx.err(line);
		return { success: false, error: { ...error, details: { ...summary, ...error.details } } };
	};
	const suite = await (authoring.findSuite ?? defaultFindSuite)(ctx, opts.suite ?? pointer.suite);
	if (!suite.success) {
		return keep(
			uiError("verify_unavailable", `cannot verify: ${suite.error.message}`, {
				hint: "fix the suite config or pass --suite <name>, then `record stop` again; --no-verify skips it. The journal is kept",
			})
		);
	}
	const outDir = join(uiDir(ctx, device.udid), "verify", String(ctx.now()));
	const helper = helperStatus(ctx, device.udid);
	const state = readState(ctx, device.udid);
	const input: VerifyInput = {
		udid: device.udid,
		platform: device.platform,
		deviceName: device.name,
		specPath: pointer.target.path,
		suite: suite.data,
		outDir,
		metroUrl: state.metroUrl,
		simdSocket: helper.running ? (helper.socket ?? undefined) : undefined,
	};
	let ran: Result<VerifyReport, string>;
	try {
		ran = await (authoring.verify ?? defaultVerify)(ctx, input);
	} catch (error) {
		ran = { success: false, error: errorMessage(error) };
	}
	if (!ran.success) {
		return keep(
			uiError("verify_unavailable", `cannot verify: ${ran.error}`, {
				hint: "fix it and `record stop` again; --no-verify skips it. The journal is kept",
			})
		);
	}
	const report = ran.data;
	const { verify, evidence } = describeRun(report);
	if (report.passed) {
		return ok(
			finish(
				verify,
				[`verified: ${report.tests.length} test${report.tests.length === 1 ? "" : "s"} passed on ${device.udid}`],
				"verified"
			)
		);
	}
	if (opts.json !== true) printFailures(ctx, report, evidence);
	return keep(
		uiError("verify_failed", `the spec failed on the device (exit ${report.exitCode})`, {
			hint: "read screen-at-failure.txt, fix the app or `record undo` and redo the step, then `record stop` again; `record cancel` drops it. The file and the journal are kept",
			details: { verify, evidence },
		})
	);
}

// ---- use ---------------------------------------------------------------------------------------------------------

export type RecordUseOptionValues = UiOptionValues & { suite?: string };

const HELPER_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"] as const;

/** The helper's source file: the path as given, or with a TypeScript / JavaScript extension. */
function helperFile(path: string): string | undefined {
	return [path, ...HELPER_EXTENSIONS.map((extension) => `${path.replace(/\.[cm]?[jt]sx?$/, "")}${extension}`)].find(
		(candidate) => existsSync(candidate) && !candidate.endsWith("/")
	);
}

/** Whether `source` exports `fn`: a declaration, or a name in an `export { … }` list. */
function exportsHelper(source: string, fn: string): boolean {
	if (exportsName(source, fn)) return true;
	const lists = source.matchAll(/^export\s*\{([^}]*)\}/gm);
	return [...lists].some((list) =>
		(list[1] ?? "").split(",").some((entry) => (entry.split(/\s+as\s+/).at(-1) ?? "").trim() === fn)
	);
}

/** The throwaway spec for one helper call, built by the same codegen a recording goes through. */
function useSpec(recording: Recording, step: RecordedStep, shape: SpecShape, file: string): string {
	return generateSpec(
		{ ...recording, name: `use ${step.kind === "use" ? step.fn : "helper"}`, title: "use helper", steps: [step] },
		{ file, launch: shape.launch, ...(shape.specOptions !== undefined ? { specOptions: shape.specOptions } : {}) }
	).source;
}

/**
 * `warden ui record use <module#fn>`: run the helper once on this device (a generated one-test spec through the same
 * spec process `record stop` verifies with), and only when it passes append a `use` step. The spec then calls
 * `await fn(fixtures)`. The next snapshot, refs and route start from the screen the helper left behind. A failing
 * helper records nothing.
 */
export function uiRecordUse(
	ctx: CommandContext,
	deps: UiDeps,
	ref: string,
	opts: RecordUseOptionValues
): Promise<number> {
	return runUi(ctx, deps, "record use", opts, async (device, env) => {
		const active = activeRecording(ctx, device.udid);
		if (!active.success) return active;
		const { pointer, journal } = active.data;
		const parsed = parseHelperRef(ref);
		if (!parsed.success) return failed("usage", parsed.error.replace("--helper", "record use"));
		const requested = resolve(ctx.cwd, parsed.data.module);
		const module = helperFile(requested);
		const { fn } = parsed.data;
		if (module === undefined) {
			return failed("helper_missing", `${requested} does not exist`, {
				hint: "give the helpers module as <path>#<fn>, relative to the working directory",
			});
		}
		if (!exportsHelper(readFileSync(module, "utf8"), fn)) {
			return failed("helper_missing", `${module} does not export ${fn}`, {
				hint: "export it, or record it first with `record start <name> --helper <module>#<fn>`",
			});
		}
		if (pointer.target.path === module && pointer.target.kind === "helper" && pointer.target.fn === fn) {
			return failed("usage", `${fn} is the helper being recorded`);
		}
		const read = readJournal(journal);
		if (!read.success) return journalFailure(read.error, "`warden ui record cancel` clears it");
		const authoring = deps.authoring ?? {};
		const suite = await (authoring.findSuite ?? defaultFindSuite)(ctx, opts.suite ?? pointer.suite);
		if (!suite.success) {
			return failed("verify_unavailable", `cannot run the helper: ${suite.error.message}`, {
				hint: "fix the suite config or pass --suite <name>",
			});
		}
		const stamp = String(ctx.now());
		const outDir = join(uiDir(ctx, device.udid), "use", stamp);
		const specDir = join(suite.data.cwd, "node_modules", ".cache", "warden-use", stamp);
		const specPath = join(specDir, "use.e2e.ts");
		const useStep: RecordedStep = { i: 0, at: ctx.now(), kind: "use", module, fn };
		const shape = await specShapeFor(
			ctx,
			authoring,
			pointer,
			{ ...read.data, steps: [useStep] },
			specPath,
			opts.suite ?? pointer.suite
		);
		write(specPath, useSpec(read.data, useStep, shape, specPath));
		const helper = helperStatus(ctx, device.udid);
		const input: VerifyInput = {
			udid: device.udid,
			platform: device.platform,
			deviceName: device.name,
			specPath,
			suite: suite.data,
			outDir,
			metroUrl: readState(ctx, device.udid).metroUrl,
			simdSocket: helper.running ? (helper.socket ?? undefined) : undefined,
		};
		let ran: Result<VerifyReport, string>;
		try {
			ran = await (authoring.verify ?? defaultVerify)(ctx, input);
		} catch (error) {
			ran = { success: false, error: errorMessage(error) };
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
		if (!ran.success) {
			return failed("verify_unavailable", `cannot run the helper: ${ran.error}`, {
				hint: "nothing was recorded; fix it and run `record use` again",
			});
		}
		const report = ran.data;
		const { verify, evidence } = describeRun(report);
		if (!report.passed) {
			if (opts.json !== true) printFailures(ctx, report, evidence);
			return failed("use_failed", `${fn} failed on the device (exit ${report.exitCode})`, {
				hint: "read screen-at-failure.txt, fix the helper or the app, then run `record use` again; nothing was recorded",
				details: { module, fn, verify, evidence },
			});
		}
		const { takeSnapshot } = await import("./snapshot");
		const driver = await env.driver();
		if (driver.success) {
			await takeSnapshot(ctx, deps, driver.data, device.udid, {
				interactiveOnly: true,
				all: false,
				settle: { budgetMs: USE_SETTLE_MS },
			});
		}
		const before = readState(ctx, device.udid).recording?.routes?.last;
		const { routeAfter } = await import("./record");
		const route = await routeAfter(ctx, deps, env, device, "use");
		const after = readState(ctx, device.udid).recording?.routes?.last;
		const recorded = loadHelperRoutes(ctx, module, fn);
		const visited = visitedRoutes(before, recorded ?? [], after);
		const partial = recorded === undefined || recorded.length === 0;
		const appended = await appendStep(journal, {
			kind: "use",
			at: ctx.now(),
			module,
			fn,
			...(route !== undefined ? { route } : {}),
			visited,
			...(partial ? { partial: true as const } : {}),
		});
		if (!appended.success) return journalFailure(appended.error);
		return ok({
			device: deviceOf(device),
			result: {
				outcome: "used",
				step: appended.data.i,
				module,
				fn,
				...(route !== undefined ? { route } : {}),
				visited,
				routes: partial ? "reads" : "recording",
				verify,
			},
			text: [
				`${fn} passed on ${device.udid}; recorded as step ${appended.data.i} (await ${fn}(fixtures)). Next: \`wait\` for a testID of the screen it leaves you on`,
				visited.length === 0
					? "routes: none read (not a dev client)"
					: `routes: ${visited.join(", ")}${partial ? " (only the reads before and after the run: the helper has no recording of its own)" : " (from its recording)"}`,
			].join("\n"),
		});
	});
}

/** How long to wait for the screen the helper left behind before the fresh snapshot is taken. */
const USE_SETTLE_MS = 3_000;
