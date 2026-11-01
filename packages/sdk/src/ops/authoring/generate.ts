import { dirname, relative, resolve } from "node:path";
import {
	generateHelper,
	generateSpec,
	mergeIdsModule,
	parseIdsModule,
	type SharedSpecOptions,
} from "@delacour/warden-e2e/authoring/codegen";
import type { Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import type { RecordSpecConfig } from "../../contracts/record.schema";
import type { OpSession } from "../session";
import { failed, findSuiteOf, readIfExists, write } from "./common";
import { helpersWithGaps, specConfigFor, stepRoutes, visitedRoutes } from "./config";
import { saveHelperRoutes } from "./helper-routes";
import { findSharedSpecOptions, neededLaunch, reloadOptions } from "./options";
import type { RecordingPointer } from "./pointer";
import { readCurrentRoute } from "./route";
import { importPath } from "./spec-target";

/** What the generated spec's `test.use` says: the suite's shared options, and the launch the recording needs. */
export type SpecShape = {
	specOptions?: SharedSpecOptions;
	launch: "none" | "fresh";
	/** several shared options objects fit and none was chosen */
	ambiguous?: string[];
};

export type Written = {
	file: string;
	fn?: string;
	replaced: boolean;
	source: string;
	ids: { file: string; added: Record<string, string> } | null;
};

const readIfPresent = readIfExists;

/**
 * The shared `test.use` options and launch for a spec at `file`: the `--options` the recording started with (or
 * `none`), else the one object `findSharedSpecOptions` detects in the suite's specs directory (the specs dir of the
 * suite found, else the directory of the spec). The launch is `none` when the recording opens the app itself.
 */
export async function specShapeFor(
	session: OpSession,
	pointer: RecordingPointer,
	recording: Recording,
	file: string,
	suiteName: string | undefined
): Promise<SpecShape> {
	const launch = neededLaunch(recording, readIfPresent);
	if (pointer.options === "none") return { launch };
	if (pointer.options !== undefined) return { launch, specOptions: reloadOptions(pointer.options) };
	const found = await findSuiteOf(session, suiteName);
	const specsDir = found.success ? resolve(found.data.configDir, found.data.config.specsDir) : dirname(file);
	const lookup = findSharedSpecOptions(specsDir);
	if (lookup.kind === "found") return { launch, specOptions: lookup.options };
	return lookup.kind === "ambiguous" ? { launch, ambiguous: lookup.names } : { launch };
}

/** The `test.use` shape of a spec target; a helper is always launched fresh. */
export async function shapeForTarget(
	session: OpSession,
	pointer: RecordingPointer,
	recording: Recording,
	suiteName: string | undefined
): Promise<SpecShape> {
	const { target } = pointer;
	if (target.kind !== "spec") return { launch: "fresh" };
	return specShapeFor(session, pointer, recording, target.path, suiteName);
}

type Generated = { source: string; ids: Record<string, string>; replaced: boolean };

/** Generate the spec or helper source for `recording`; nothing is written here. */
function generateTarget(
	pointer: RecordingPointer,
	recording: Recording,
	replace: boolean,
	shape: SpecShape,
	known: Record<string, string>,
	idsImport: string | undefined
): Result<Generated, WardenError> {
	const { target } = pointer;
	if (target.kind === "spec") {
		const generated = generateSpec(recording, {
			ids: known,
			file: target.path,
			launch: shape.launch,
			...(shape.specOptions !== undefined ? { specOptions: shape.specOptions } : {}),
			...(idsImport !== undefined ? { idsImport, idsMerged: true } : {}),
		});
		return ok({ source: generated.source, ids: generated.ids, replaced: false });
	}
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
			hint: generated.error.code === "helper_exists" ? "pass --overwrite to replace it" : "pick another function name",
		});
	}
	const { source, ids, replaced } = generated.data;
	return ok({ source, ids, replaced });
}

/** The ids module text to write: the recording's ids merged into what exists; undefined when nothing changes. */
function mergedIdsText(
	idsPath: string,
	existing: string | undefined,
	ids: Record<string, string>
): Result<string | undefined, WardenError> {
	const merged = mergeIdsModule(existing, ids);
	if (!merged.success) {
		return failed("failed", `${idsPath}: ${merged.error.message}`, { details: { code: merged.error.code } });
	}
	return ok(merged.data !== existing ? merged.data : undefined);
}

/** Generate the spec or helper for `recording` and write it (and the merged ids module); nothing is written when generation fails. */
export function writeTarget(
	pointer: RecordingPointer,
	recording: Recording,
	overwrite: boolean,
	shape: SpecShape
): Result<Written, WardenError> {
	const { target } = pointer;
	const idsExisting = pointer.ids === undefined ? undefined : readIfExists(pointer.ids);
	const known = idsExisting === undefined ? {} : parseIdsModule(idsExisting);
	const idsImport = pointer.ids === undefined ? undefined : importPath(target.path, pointer.ids);

	const generated = generateTarget(pointer, recording, overwrite || pointer.wrote === true, shape, known, idsImport);
	if (!generated.success) return generated;
	const { source, ids, replaced } = generated.data;
	let idsText: string | undefined;
	if (pointer.ids !== undefined) {
		const merged = mergedIdsText(pointer.ids, idsExisting, ids);
		if (!merged.success) return merged;
		idsText = merged.data;
	}
	write(target.path, source);
	if (pointer.ids !== undefined && idsText !== undefined) write(pointer.ids, idsText);
	const added = Object.fromEntries(Object.entries(ids).filter(([key]) => !(key in known)));
	return ok({
		file: target.path,
		...(target.kind === "helper" ? { fn: target.fn } : {}),
		replaced,
		source,
		ids: pointer.ids === undefined ? null : { file: pointer.ids, added: idsText !== undefined ? added : {} },
	});
}

/**
 * The `specs.<id>` proposal for a written spec (null for a helper): the routes the recording visited, mapped to files
 * under the suite's `routerRoot`. The app is asked once more for the route it ended on. A missing suite only costs
 * the mapping; nothing here fails the stop.
 */
export async function configForTarget(
	session: OpSession,
	pointer: RecordingPointer,
	recording: Recording,
	suiteName: string | undefined
): Promise<RecordSpecConfig | null> {
	const { target } = pointer;
	if (target.kind !== "spec") return null;
	const [final, found, { routeEntries }, { specIdOf }] = await Promise.all([
		readCurrentRoute(session),
		findSuiteOf(session, suiteName),
		import("@delacour/warden-core/affected/routes"),
		import("@delacour/warden-core/affected/specs"),
	]);
	const routes = visitedRoutes(pointer.routes?.initial, stepRoutes(recording.steps), final);
	return specConfigFor({
		file: target.path,
		routes,
		suite: found.success ? found.data : undefined,
		devicePlatform: session.device.platform,
		helperGaps: helpersWithGaps(recording.steps),
		resolveRoutes: routeEntries,
		specId: specIdOf,
	});
}

/**
 * A helper recording's routes (its start, its steps, where it ended), saved for the `record use` of that helper in a
 * later recording; a helper recorded on a release build saves an empty list.
 */
export async function rememberHelperRoutes(
	session: OpSession,
	pointer: RecordingPointer,
	recording: Recording
): Promise<void> {
	const { target } = pointer;
	if (target.kind !== "helper") return;
	const final = await readCurrentRoute(session);
	saveHelperRoutes(
		session.host.home,
		target.path,
		target.fn,
		visitedRoutes(pointer.routes?.initial, stepRoutes(recording.steps), final)
	);
}

/** What `test.use` the written spec got, in words. */
export function shapeLines(shape: SpecShape, file: string): string[] {
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
