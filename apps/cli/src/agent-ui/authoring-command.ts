import type { Suite, SuiteError } from "@delacour/warden-core/affected/affected";
import { activeRecording } from "@delacour/warden-sdk/ops/authoring/common";
import type { AuthoringDeps as SdkAuthoringDeps } from "@delacour/warden-sdk/ops/authoring/deps";
import { recordCancel, recordNote, recordStatus, recordUndo } from "@delacour/warden-sdk/ops/authoring/journal-ops";
import type { RecordStartParams } from "@delacour/warden-sdk/ops/authoring/start";
import type { OpSession } from "@delacour/warden-sdk/ops/session";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { positiveInt } from "./args";
import type { VerifyInput, VerifyReport } from "./authoring-verify";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { helperStatus } from "./helper";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { opSessionFor, reply } from "./session";

/**
 * `warden ui record`: the CLI adapter over the SDK's authoring ops (`@delacour/warden-sdk/ops/authoring/*`: the
 * journal, codegen and the verify run), lazily imported by the subcommand that runs (`authoring-register.ts`). The
 * adapter resolves the device, supplies the CLI's side effects (suite lookup, the spec runner, colours, stderr) and
 * renders the op's result. The journal lives at `recordingFile` (`$WARDEN_HOME/ui/<udid>/recording.json`);
 * `state.json.recording` says where `stop` writes it. The journal outlives a failed verify: it is removed only by a
 * successful `stop` or `cancel`, so the agent can `undo`, fix the app and `stop` again.
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

/** The SDK's authoring deps over this CLI call: its suite lookup, spec runner (with the device's helper socket), colours and stderr. */
function sdkDeps(ctx: CommandContext, deps: UiDeps, json: boolean): SdkAuthoringDeps {
	const authoring = deps.authoring ?? {};
	return {
		findSuite: (name) => (authoring.findSuite ?? defaultFindSuite)(ctx, name),
		verify: (input) => {
			const helper = helperStatus(ctx, input.udid);
			const withSocket = { ...input, simdSocket: helper.running ? (helper.socket ?? undefined) : undefined };
			return (authoring.verify ?? defaultVerify)(ctx, withSocket);
		},
		color: ctx.ui.color,
		...(json ? {} : { err: (line: string) => ctx.err(line) }),
	};
}

/** The op session of a `record` subcommand; the ones that read the app's route also get the devtools. */
async function recordSession(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	env: UiRunEnv,
	opts: UiOptionValues,
	routes: boolean
): Promise<OpSession> {
	const authoring = sdkDeps(ctx, deps, opts.json === true);
	if (!routes) return opSessionFor(ctx, deps, device, env, { authoring });
	const { extrasFor } = await import("./devtools-cli");
	return opSessionFor(ctx, deps, device, env, { ...extrasFor(ctx, deps, device), authoring });
}

// ---- start -------------------------------------------------------------------------------------------------------

export type RecordStartOptionValues = UiOptionValues &
	Omit<RecordStartParams, "name" | "overwrite"> & { overwrite?: true };

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
		const { recordStart } = await import("@delacour/warden-sdk/ops/authoring/start");
		const session = await recordSession(ctx, deps, device, env, opts, true);
		return reply(device, await recordStart(session, { ...opts, name }));
	});
}

// ---- note / undo / status / cancel ---------------------------------------------------------------------------------

/** `warden ui record note "<text>"`: a user-visible step boundary; codegen writes it as a comment above the next step. */
export function uiRecordNote(ctx: CommandContext, deps: UiDeps, text: string, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record note", opts, async (device, env) =>
		reply(device, await recordNote(await recordSession(ctx, deps, device, env, opts, false), { text }))
	);
}

/** `warden ui record undo [n]`: drop the last `n` steps (default 1; notes count) from the journal. */
export function uiRecordUndo(
	ctx: CommandContext,
	deps: UiDeps,
	count: string | undefined,
	opts: UiOptionValues
): Promise<number> {
	return runUi(ctx, deps, "record undo", opts, async (device, env) => {
		const session = await recordSession(ctx, deps, device, env, opts, false);
		const active = activeRecording(session);
		if (!active.success) return active;
		const n = count === undefined ? undefined : positiveInt("undo count", count);
		if (n !== undefined && !n.success) return n;
		return reply(device, await recordUndo(session, n === undefined ? {} : { count: n.data }));
	});
}

/** `warden ui record status`: the target, the step count, the last five steps and the lints so far. */
export function uiRecordStatus(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record status", opts, async (device, env) =>
		reply(device, await recordStatus(await recordSession(ctx, deps, device, env, opts, false)))
	);
}

/** `warden ui record cancel`: throw the journal away. A spec already written by a failed `stop` is left in place. */
export function uiRecordCancel(ctx: CommandContext, deps: UiDeps, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "record cancel", opts, async (device, env) =>
		reply(device, await recordCancel(await recordSession(ctx, deps, device, env, opts, false)))
	);
}

// ---- stop --------------------------------------------------------------------------------------------------------

export type RecordStopOptionValues = UiOptionValues & {
	/** false = `--no-verify` */
	verify: boolean;
	overwrite?: true;
	suite?: string;
};

/**
 * `warden ui record stop`: write the spec (or helper), merge the ids module, print the lints and, unless `--no-verify`
 * (or a helper), run the spec once on this device. A failed verify exits 1 and keeps both the file and the journal:
 * `record undo` / fix the app / `record stop` again, or `record cancel`. The journal is removed only on success.
 */
export function uiRecordStop(ctx: CommandContext, deps: UiDeps, opts: RecordStopOptionValues): Promise<number> {
	return runUi(ctx, deps, "record stop", opts, async (device, env) => {
		const { recordStop } = await import("@delacour/warden-sdk/ops/authoring/stop");
		const session = await recordSession(ctx, deps, device, env, opts, true);
		return reply(
			device,
			await recordStop(session, {
				verify: opts.verify,
				...(opts.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
				...(opts.suite !== undefined ? { suite: opts.suite } : {}),
			})
		);
	});
}

// ---- use ---------------------------------------------------------------------------------------------------------

export type RecordUseOptionValues = UiOptionValues & { suite?: string };

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
		const { recordUse } = await import("@delacour/warden-sdk/ops/authoring/use");
		const session = await recordSession(ctx, deps, device, env, opts, true);
		return reply(
			device,
			await recordUse(session, { helper: ref, ...(opts.suite !== undefined ? { suite: opts.suite } : {}) })
		);
	});
}
