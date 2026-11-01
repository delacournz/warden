import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { journalStore } from "@delacour/warden-e2e/authoring/journal";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { RecordStarted } from "../../contracts/record.schema";
import { fromDriver } from "../errors";
import type { OpOutcome, OpSession } from "../session";
import type { DeviceState } from "../state-store";
import { failed, findSuiteOf, journalFailure, journalOf, readIfExists, targetPath } from "./common";
import { resolveOptionsRef } from "./options";
import type { RecordingPointer } from "./pointer";
import { startRoute } from "./route";
import { exportsName, type HelperRef, parseHelperRef, slugOf } from "./spec-target";

export type RecordStartParams = {
	/** recording name (the spec file name unless `to`) */
	name: string;
	/** spec file to write */
	to?: string;
	/** `module#fn`: write an exported function into a helpers module instead of a spec */
	helper?: string;
	/** what must be true before the helper runs (its doc comment); needs `helper` */
	prerequisite?: string;
	/** ids module to merge test ids into */
	ids?: string;
	/** shared `test.use` options as `module#name`; `none` passes none */
	options?: string;
	/** the generated test's title (default: the name) */
	title?: string;
	/** `e2e.<name>` suite for the default path and the verify run */
	suite?: string;
	/** replace an existing spec file, or an existing helper function */
	overwrite?: boolean;
};

type Resolved = { target: RecordingPointer["target"]; suite?: string };

/** The spec a recording writes by default: `<suite specsDir>/<slug>.e2e.ts`, else `e2e/<slug>.e2e.ts` under the working directory. */
async function defaultSpecPath(
	session: OpSession,
	slug: string,
	suite: string | undefined
): Promise<Result<string, WardenError>> {
	const found = await findSuiteOf(session, suite);
	if (found.success)
		return resultFactory.ok(resolve(found.data.configDir, found.data.config.specsDir, `${slug}.e2e.ts`));
	if (suite !== undefined || found.error.code === "several_suites") {
		return failed("usage", found.error.message, {
			hint: "pick one with --suite <name>, or give the spec path with --to",
		});
	}
	return resultFactory.ok(join(session.host.cwd, "e2e", `${slug}.e2e.ts`));
}

/** `helper`: where the helper goes; an export of that name is replaced only with `overwrite`. */
function resolveHelperTarget(
	session: OpSession,
	rawHelper: string,
	p: RecordStartParams
): Result<Resolved, WardenError> {
	const ref: Result<HelperRef> = parseHelperRef(rawHelper);
	if (!ref.success) return failed("usage", ref.error);
	const path = resolve(session.host.cwd, ref.data.module);
	const existing = readIfExists(path);
	if (existing !== undefined && exportsName(existing, ref.data.fn) && p.overwrite !== true) {
		return failed("target_exists", `${ref.data.module} already exports ${ref.data.fn}`, {
			hint: "pick another function name, or pass --overwrite to replace it",
		});
	}
	return resultFactory.ok({
		target: {
			kind: "helper",
			path,
			fn: ref.data.fn,
			...(p.prerequisite !== undefined ? { prerequisite: p.prerequisite } : {}),
		},
		...(p.suite !== undefined ? { suite: p.suite } : {}),
	});
}

/** `to` without `suite` is refused when several suites exist: `record use` and the verify run need one. */
async function checkSuiteChosen(session: OpSession, p: RecordStartParams): Promise<Result<undefined, WardenError>> {
	if (p.to === undefined || p.suite !== undefined) return resultFactory.ok(undefined);
	const found = await findSuiteOf(session, undefined);
	if (!found.success && found.error.code === "several_suites") {
		return failed("usage", found.error.message, {
			hint: "pass --suite <name> now: `record use` and the verify run on that suite",
		});
	}
	return resultFactory.ok(undefined);
}

/** The spec a recording writes: `to`, else the suite's default path; an existing file is replaced only with `overwrite`. */
async function resolveSpecTarget(
	session: OpSession,
	name: string,
	p: RecordStartParams
): Promise<Result<Resolved, WardenError>> {
	const chosen = await checkSuiteChosen(session, p);
	if (!chosen.success) return chosen;
	const path =
		p.to !== undefined
			? resultFactory.ok(resolve(session.host.cwd, p.to))
			: await defaultSpecPath(session, slugOf(name), p.suite);
	if (!path.success) return path;
	if (existsSync(path.data) && p.overwrite !== true) {
		return failed("target_exists", `${path.data} already exists`, {
			hint: "pass --overwrite to replace it, or --to <other spec>",
		});
	}
	return resultFactory.ok({
		target: { kind: "spec", path: path.data },
		...(p.suite !== undefined ? { suite: p.suite } : {}),
	});
}

async function resolveTarget(
	session: OpSession,
	name: string,
	p: RecordStartParams
): Promise<Result<Resolved, WardenError>> {
	if (p.helper !== undefined && p.to !== undefined) {
		return failed("usage", "--helper and --to are exclusive", {
			hint: "--to writes a spec, --helper adds a function to a helpers module",
		});
	}
	if (p.prerequisite !== undefined && p.helper === undefined) {
		return failed("usage", "--prerequisite only applies to --helper");
	}
	if (p.helper !== undefined) return resolveHelperTarget(session, p.helper, p);
	return resolveSpecTarget(session, name, p);
}

/** `options` (`module#name`) as the pointer keeps it (absolute module); `none` switches the shared options off. */
function pinnedOptions(session: OpSession, raw: string | undefined): Result<RecordingPointer["options"], WardenError> {
	if (raw === undefined) return resultFactory.ok(undefined);
	if (raw.trim() === "none") return resultFactory.ok("none");
	const ref = resolveOptionsRef(raw, session.host.cwd);
	if (!ref.success) {
		return failed("usage", ref.error, {
			hint: "--options <module>#<name> names an exported object of test.use options, or `none` to pass none",
		});
	}
	return resultFactory.ok({ module: ref.data.module, name: ref.data.name });
}

/** `record start` needs a usable name and no recording already running on the device. */
function checkStartable(name: string, state: DeviceState): Result<undefined, WardenError> {
	if (slugOf(name) === "") {
		return failed("usage", "record start needs a name", { hint: 'warden ui record start "sign in"' });
	}
	if (state.recording) {
		return failed("recording_active", `already recording "${state.recording.name}"`, {
			hint: "`warden ui record stop` writes it, `record cancel` throws it away",
		});
	}
	return resultFactory.ok(undefined);
}

/** A fresh journal for the recording; one left here belongs to a recording that died before it could be stopped. */
function startJournal(
	session: OpSession,
	state: DeviceState,
	screen: { width: number; height: number; scale: number },
	name: string,
	title: string | undefined
): Result<string, WardenError> {
	const journal = journalOf(session);
	if (existsSync(journal)) journalStore.deleteJournal(journal);
	const { width, height, scale } = screen;
	const created = journalStore.createJournal(journal, {
		name,
		...(title ? { title } : {}),
		createdAt: session.host.now(),
		recordedOn: {
			platform: session.device.platform,
			device: session.device.name ?? session.device.id,
			screen: { width, height, scale },
			...(state.app !== undefined ? { app: state.app } : {}),
			...(state.metroUrl !== undefined ? { metro: state.metroUrl } : {}),
		},
	});
	return created.success ? resultFactory.ok(journal) : journalFailure(created.error);
}

/** The pointer the device state keeps while the recording runs. */
function startedPointer(
	session: OpSession,
	name: string,
	title: string | undefined,
	resolved: Resolved,
	ids: string | undefined,
	options: RecordingPointer["options"],
	overwrite: boolean
): RecordingPointer {
	return {
		name,
		...(title ? { title } : {}),
		target: resolved.target,
		...(ids !== undefined ? { ids } : {}),
		...(resolved.suite !== undefined ? { suite: resolved.suite } : {}),
		...(options !== undefined ? { options } : {}),
		...(overwrite ? { overwrite: true as const } : {}),
		startedAt: session.host.now(),
	};
}

function startedResult(
	name: string,
	target: RecordingPointer["target"],
	ids: string | undefined,
	journal: string
): RecordStarted {
	return {
		outcome: "started",
		name,
		kind: target.kind,
		target: target.path,
		...(target.kind === "helper" ? { fn: target.fn } : {}),
		...(ids !== undefined ? { ids } : {}),
		journal,
	};
}

/**
 * `record start <name>`: from now on every action (and `record note`) is appended to the device's journal. `record
 * stop` turns it into the spec (`to`, default `<suite specsDir>/<name>.e2e.ts`) or, with `helper`, an exported function
 * in a helpers module.
 */
export async function recordStart(session: OpSession, p: RecordStartParams): OpOutcome<RecordStarted> {
	const name = p.name.trim();
	const state = session.state.read();
	const startable = checkStartable(name, state);
	if (!startable.success) return startable;
	const resolved = await resolveTarget(session, name, p);
	if (!resolved.success) return resolved;
	const shared = pinnedOptions(session, p.options);
	if (!shared.success) return shared;
	const driver = await session.driver();
	if (!driver.success) return driver;
	const health = fromDriver(await driver.data.health());
	if (!health.success) return health;

	const title = p.title?.trim();
	const journal = startJournal(session, state, health.data.screen, name, title);
	if (!journal.success) return journal;
	const ids = p.ids === undefined ? undefined : resolve(session.host.cwd, p.ids);
	const pointer = startedPointer(session, name, title, resolved.data, ids, shared.data, p.overwrite === true);
	session.state.update((current) => ({ ...current, recording: pointer }));
	await startRoute(session);
	const { target } = resolved.data;
	return resultFactory.ok({
		result: startedResult(name, target, ids, journal.data),
		text: [
			`recording "${name}" → ${targetPath(target)}`,
			"every warden ui action is appended; `record note` marks a step, `record undo` drops one, `record stop` writes it (--no-record skips one action)",
		].join("\n"),
	});
}
