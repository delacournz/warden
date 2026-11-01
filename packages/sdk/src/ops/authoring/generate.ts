import { dirname, relative, resolve } from "node:path";
import { type SharedSpecOptions, specGenerator } from "@delacour/warden-e2e/authoring/codegen";
import type { Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { RecordSpecConfig } from "../../contracts/record.schema";
import type { OpSession } from "../session";
import { authoringCommon } from "./common";
import { specConfigBuilder } from "./config";
import { helperRoutes } from "./helper-routes";
import { specOptionsFinder } from "./options";
import type { RecordingPointer } from "./pointer";
import { routeTracker } from "./route";
import { specTargets } from "./spec-target";

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

type Generated = { source: string; ids: Record<string, string>; replaced: boolean };

/** Generates the spec or helper for a recording and writes it with its ids module. */
export class SpecWriter {
	/**
	 * The shared `test.use` options and launch for a spec at `file`: the `--options` the recording started with (or
	 * `none`), else the one object `findSharedSpecOptions` detects in the suite's specs directory (the specs dir of the
	 * suite found, else the directory of the spec). The launch is `none` when the recording opens the app itself.
	 */
	async specShapeFor(
		session: OpSession,
		pointer: RecordingPointer,
		recording: Recording,
		file: string,
		suiteName: string | undefined
	): Promise<SpecShape> {
		const launch = specOptionsFinder.neededLaunch(recording, (module) => authoringCommon.readIfExists(module));
		if (pointer.options === "none") return { launch };
		if (pointer.options !== undefined) return { launch, specOptions: specOptionsFinder.reloadOptions(pointer.options) };
		const found = await authoringCommon.findSuiteOf(session, suiteName);
		const specsDir = found.success ? resolve(found.data.configDir, found.data.config.specsDir) : dirname(file);
		const lookup = specOptionsFinder.findSharedSpecOptions(specsDir);
		if (lookup.kind === "found") return { launch, specOptions: lookup.options };
		return lookup.kind === "ambiguous" ? { launch, ambiguous: lookup.names } : { launch };
	}

	/** The `test.use` shape of a spec target; a helper is always launched fresh. */
	async shapeForTarget(
		session: OpSession,
		pointer: RecordingPointer,
		recording: Recording,
		suiteName: string | undefined
	): Promise<SpecShape> {
		const { target } = pointer;
		if (target.kind !== "spec") return { launch: "fresh" };
		return this.specShapeFor(session, pointer, recording, target.path, suiteName);
	}

	/** Generate the spec or helper source for `recording`; nothing is written here. */
	private generateTarget(
		pointer: RecordingPointer,
		recording: Recording,
		replace: boolean,
		shape: SpecShape,
		known: Record<string, string>,
		idsImport: string | undefined
	): Result<Generated, WardenError> {
		const { target } = pointer;
		if (target.kind === "spec") {
			const generated = specGenerator.generateSpec(recording, {
				ids: known,
				file: target.path,
				launch: shape.launch,
				...(shape.specOptions !== undefined ? { specOptions: shape.specOptions } : {}),
				...(idsImport !== undefined ? { idsImport, idsMerged: true } : {}),
			});
			return resultFactory.ok({ source: generated.source, ids: generated.ids, replaced: false });
		}
		const generated = specGenerator.generateHelper(recording, {
			name: target.fn,
			ids: known,
			file: target.path,
			existing: authoringCommon.readIfExists(target.path),
			force: replace,
			...(target.prerequisite !== undefined ? { prerequisite: target.prerequisite } : {}),
			...(idsImport !== undefined ? { idsImport } : {}),
		});
		if (!generated.success) {
			return authoringCommon.failed(
				generated.error.code === "helper_exists" ? "target_exists" : "failed",
				generated.error.message,
				{
					details: { code: generated.error.code },
					hint:
						generated.error.code === "helper_exists" ? "pass --overwrite to replace it" : "pick another function name",
				}
			);
		}
		const { source, ids, replaced } = generated.data;
		return resultFactory.ok({ source, ids, replaced });
	}

	/** The ids module text to write: the recording's ids merged into what exists; undefined when nothing changes. */
	private mergedIdsText(
		idsPath: string,
		existing: string | undefined,
		ids: Record<string, string>
	): Result<string | undefined, WardenError> {
		const merged = specGenerator.mergeIdsModule(existing, ids);
		if (!merged.success) {
			return authoringCommon.failed("failed", `${idsPath}: ${merged.error.message}`, {
				details: { code: merged.error.code },
			});
		}
		return resultFactory.ok(merged.data !== existing ? merged.data : undefined);
	}

	/** Generate the spec or helper for `recording` and write it (and the merged ids module); nothing is written when generation fails. */
	writeTarget(
		pointer: RecordingPointer,
		recording: Recording,
		overwrite: boolean,
		shape: SpecShape
	): Result<Written, WardenError> {
		const { target } = pointer;
		const idsExisting = pointer.ids === undefined ? undefined : authoringCommon.readIfExists(pointer.ids);
		const known = idsExisting === undefined ? {} : specGenerator.parseIdsModule(idsExisting);
		const idsImport = pointer.ids === undefined ? undefined : specTargets.importPath(target.path, pointer.ids);

		const generated = this.generateTarget(
			pointer,
			recording,
			overwrite || pointer.wrote === true,
			shape,
			known,
			idsImport
		);
		if (!generated.success) return generated;
		const { source, ids, replaced } = generated.data;
		let idsText: string | undefined;
		if (pointer.ids !== undefined) {
			const merged = this.mergedIdsText(pointer.ids, idsExisting, ids);
			if (!merged.success) return merged;
			idsText = merged.data;
		}
		authoringCommon.write(target.path, source);
		if (pointer.ids !== undefined && idsText !== undefined) authoringCommon.write(pointer.ids, idsText);
		const added = Object.fromEntries(Object.entries(ids).filter(([key]) => !(key in known)));
		return resultFactory.ok({
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
	async configForTarget(
		session: OpSession,
		pointer: RecordingPointer,
		recording: Recording,
		suiteName: string | undefined
	): Promise<RecordSpecConfig | null> {
		const { target } = pointer;
		if (target.kind !== "spec") return null;
		const [final, found, { routeResolver }, { specScanner }] = await Promise.all([
			routeTracker.readCurrentRoute(session),
			authoringCommon.findSuiteOf(session, suiteName),
			import("@delacour/warden-core/affected/routes"),
			import("@delacour/warden-core/affected/specs"),
		]);
		const routes = specConfigBuilder.visitedRoutes(
			pointer.routes?.initial,
			specConfigBuilder.stepRoutes(recording.steps),
			final
		);
		return specConfigBuilder.specConfigFor({
			file: target.path,
			routes,
			suite: found.success ? found.data : undefined,
			devicePlatform: session.device.platform,
			helperGaps: specConfigBuilder.helpersWithGaps(recording.steps),
			resolveRoutes: (...args) => routeResolver.entries(...args),
			specId: (...args) => specScanner.idOf(...args),
		});
	}

	/**
	 * A helper recording's routes (its start, its steps, where it ended), saved for the `record use` of that helper in a
	 * later recording; a helper recorded on a release build saves an empty list.
	 */
	async rememberHelperRoutes(session: OpSession, pointer: RecordingPointer, recording: Recording): Promise<void> {
		const { target } = pointer;
		if (target.kind !== "helper") return;
		const final = await routeTracker.readCurrentRoute(session);
		helperRoutes.saveHelperRoutes(
			session.host.home,
			target.path,
			target.fn,
			specConfigBuilder.visitedRoutes(pointer.routes?.initial, specConfigBuilder.stepRoutes(recording.steps), final)
		);
	}

	/** What `test.use` the written spec got, in words. */
	shapeLines(shape: SpecShape, file: string): string[] {
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
}

export const specWriter = new SpecWriter();
