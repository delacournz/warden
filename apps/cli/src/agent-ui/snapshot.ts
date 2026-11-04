import { canReadA11y } from "@delacour/warden-e2e/driver/a11y-read";
import type { Driver, Element, ElementA11y, Rect, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { assignRefs, type RefTable } from "@delacour/warden-e2e/driver/refs";
import { DEFAULT_SETTLE_QUIET_MS, settleByHash, snapshotHash } from "@delacour/warden-e2e/driver/settle";
import { indexSnapshot, type NodeEntry } from "@delacour/warden-e2e/screen/nodes";
import { resolve } from "@delacour/warden-e2e/screen/query";
import { isListed, renderEntryLine, renderHeader, renderSnapshot } from "@delacour/warden-e2e/screen/render";
import { isInteractiveRole } from "@delacour/warden-e2e/screen/roles";
import { type ParsedSelector, selectorToQuery } from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { diffSnapshots, renderDiff, type SnapshotDiff } from "./diff";
import { driverUiError, type UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { commitGeneration, preorder, readLastSnapshot, writeLastSnapshot } from "./state";

/** Lines printed by a plain `snapshot` before `… N more (use --all)`. */
export const DEFAULT_MAX_LINES = 200;

export type SnapshotRequest = {
	/** `-i`: interactive roles and anything with a testID */
	interactiveOnly: boolean;
	/** `--all`: no line cap */
	all: boolean;
	/** `--depth n`: only the first n levels of the tree */
	depth?: number;
	/** with `-i` during a recording: mark interactive elements that have no testID (`[no-id]`) */
	markMissingIds?: boolean;
	/** `--settle [ms]`: wait for a quiet screen (budget in ms), then diff against the previous snapshot */
	settle?: { budgetMs: number };
	/** `--a11y`: merge the screen-reader facts (iOS: the injected library's read) and print the hint / actions / focus columns */
	a11y?: boolean;
};

/** One element of the `--json` result (`result.elements`): what a line shows, structured. */
export type ElementJson = {
	ref?: string;
	role: string;
	name?: string;
	id?: string;
	value?: string;
	enabled: boolean;
	hittable?: boolean;
	selected?: boolean;
	checked?: boolean;
	frame: Rect;
	/** `--a11y`: the screen-reader facts the backend read */
	a11y?: ElementA11y;
	/** an interactive element without a testID (only set while a recording is active) */
	noId?: true;
};

export const NO_ID_MARK = "[no-id]";

export type TakenSnapshot = {
	snapshot: Snapshot;
	refs: RefTable;
	hash: string;
	generation: number;
	/** `generation N · <backend> · <W×H@scale> · <count> elements[, truncated]` */
	header: string;
	/** one line per element (+ the `… N more` line when capped) */
	lines: string[];
	/** structured twin of `lines` */
	elements: ElementJson[];
	/** `--a11y` on an iOS app launched without the injected library: hint / actions / order are absent */
	a11yMissing?: true;
	/** advice printed after the lines (`[no-id]` marks) */
	hints: string[];
	total: number;
	shown: number;
	omitted: number;
	settle?: { quiet: boolean; waitedMs: number };
	/** versus the stored snapshot of the previous generation (`--settle` only) */
	diff?: SnapshotDiff & { against: number };
};

/** First `levels` levels of the tree; `flat` follows. Refs are assigned on the full tree first, so they don't move with `--depth`. */
function pruneDepth(snapshot: Snapshot, levels: number): Snapshot {
	const cut = (elements: readonly Element[], level: number): Element[] =>
		level >= levels ? [] : elements.map((element) => ({ ...element, children: cut(element.children, level + 1) }));
	const elements = cut(snapshot.elements, 0);
	return { ...snapshot, elements, flat: preorder(elements) };
}

export function elementJson(entry: NodeEntry, ref: string | undefined, withA11y = false): ElementJson {
	const { element, states } = entry;
	return {
		...(withA11y && element.a11y !== undefined ? { a11y: element.a11y } : {}),
		...(ref !== undefined ? { ref } : {}),
		role: entry.role,
		...(entry.name !== undefined ? { name: entry.name } : {}),
		...(element.identifier ? { id: element.identifier } : {}),
		...(entry.value !== undefined ? { value: entry.value } : {}),
		enabled: !states.disabled,
		...(element.hittable !== undefined ? { hittable: element.hittable } : {}),
		...(states.selected ? { selected: true } : {}),
		...(states.checked !== undefined ? { checked: states.checked } : {}),
		frame: element.frame,
	};
}

/**
 * The snapshot with the screen-reader facts of `Element.a11y` filled in where the platform needs a second read (iOS: the
 * injected library; Android snapshots carry them). `missing`: an iOS app launched without the library.
 */
async function withA11yFacts(
	driver: Driver,
	snapshot: Snapshot
): Promise<Result<{ snapshot: Snapshot; missing: boolean }, UiError>> {
	if (!canReadA11y(driver)) return ok({ snapshot, missing: false });
	const read = await driver.readA11y(snapshot);
	if (read.success) return ok({ snapshot: read.data, missing: false });
	if (read.error.code === "E_UNSUPPORTED") return ok({ snapshot, missing: true });
	return { success: false, error: driverUiError(read.error) };
}

type Fetched = { snapshot: Snapshot; settle?: { quiet: boolean; waitedMs: number } };

async function fetchSnapshot(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	settle: SnapshotRequest["settle"]
): Promise<Result<Fetched, UiError>> {
	if (settle === undefined) {
		const taken = await driver.snapshot();
		return taken.success ? ok({ snapshot: taken.data }) : { success: false, error: driverUiError(taken.error) };
	}
	let latest: Snapshot | undefined;
	let failure: UiError | undefined;
	const poll = async (): Promise<string> => {
		const taken = await driver.snapshot();
		if (!taken.success) {
			failure = driverUiError(taken.error);
			throw new Error(taken.error.message);
		}
		latest = taken.data;
		return snapshotHash(taken.data);
	};
	try {
		const outcome = await settleByHash(poll, {
			quietMs: DEFAULT_SETTLE_QUIET_MS,
			timeoutMs: settle.budgetMs,
			now: ctx.now,
			sleep: deps.sleep,
		});
		return latest
			? ok({ snapshot: latest, settle: outcome })
			: { success: false, error: uiError("failed", "no snapshot") };
	} catch (error) {
		return {
			success: false,
			error: failure ?? uiError("failed", error instanceof Error ? error.message : String(error)),
		};
	}
}

/**
 * Take a snapshot of the device, give it the next generation and `@eN` refs, store it as the device's
 * `last-snapshot.json` and render it. With `settle`, polls until the screen hash stays equal for 250 ms
 * (or the budget runs out: `settle.quiet === false`) and diffs against the previously stored snapshot.
 * Refs are numbered over the whole tree, so `-i`, `--depth` and `--all` print the same `@eN` for the same element.
 */
export async function takeSnapshot(
	ctx: CommandContext,
	deps: UiDeps,
	driver: Driver,
	udid: string,
	request: SnapshotRequest
): Promise<Result<TakenSnapshot, UiError>> {
	const previous = readLastSnapshot(ctx, udid);
	const fetched = await fetchSnapshot(ctx, deps, driver, request.settle);
	if (!fetched.success) return fetched;
	const merged = request.a11y ? await withA11yFacts(driver, fetched.data.snapshot) : undefined;
	if (merged !== undefined && !merged.success) return merged;
	const snapshot = merged?.data.snapshot ?? fetched.data.snapshot;
	const { generation, refs } = storeSnapshot(ctx, udid, snapshot);
	const hash = snapshotHash(snapshot);

	const view = request.depth === undefined ? snapshot : pruneDepth(snapshot, request.depth);
	const rendered = renderSnapshot(view, {
		interactiveOnly: request.interactiveOnly,
		refs: refs.byId,
		...(request.a11y ? { a11y: true } : {}),
		...(request.all ? {} : { maxLines: DEFAULT_MAX_LINES }),
	});
	const entries = indexSnapshot(view).entries;
	const listed = (request.interactiveOnly ? entries.filter(isListed) : entries).slice(0, rendered.shown);
	const unmarked = (entry: NodeEntry): boolean =>
		request.markMissingIds === true &&
		request.interactiveOnly &&
		isInteractiveRole(entry.role) &&
		(entry.element.identifier === undefined || entry.element.identifier === "");
	const lines = rendered.lines.map((line, at) => {
		const entry = listed[at];
		return entry !== undefined && unmarked(entry) ? `${line} ${NO_ID_MARK}` : line;
	});
	const missing = listed.filter(unmarked).length;
	const taken: TakenSnapshot = {
		snapshot,
		refs,
		hash,
		generation,
		header: renderHeader({
			snapshot: view,
			rendered,
			interactiveOnly: request.interactiveOnly,
			generation,
			style: "cli",
		}),
		lines,
		elements: listed.map((entry) => ({
			...elementJson(entry, refs.byId.get(entry.element.id), request.a11y === true),
			...(unmarked(entry) ? { noId: true as const } : {}),
		})),
		hints:
			missing === 0
				? []
				: [
						`# ${missing} interactive element${missing === 1 ? "" : "s"} marked ${NO_ID_MARK}: add testID + accessible in the component, reload, \`record undo\` and redo — a text selector breaks with the copy`,
					],
		total: rendered.total,
		shown: rendered.shown,
		omitted: rendered.omitted,
		...(merged?.data.missing ? { a11yMissing: true as const } : {}),
	};
	if (fetched.data.settle) taken.settle = fetched.data.settle;
	if (request.settle && previous) {
		taken.diff = { ...diffSnapshots(previous.snapshot, snapshot, refs.byId), against: previous.generation };
	}
	return ok(taken);
}

/** The `# settled…` verdict and the `+`/`-` diff lines that follow a settled snapshot. */
export function settleLines(taken: Pick<TakenSnapshot, "settle" | "diff">): string[] {
	const out: string[] = [];
	if (taken.settle) {
		out.push(
			taken.settle.quiet
				? `# settled after ${taken.settle.waitedMs} ms`
				: `# not quiet after ${taken.settle.waitedMs} ms (gave up)`
		);
	}
	if (taken.diff) out.push(`# diff vs generation ${taken.diff.against}`, ...renderDiff(taken.diff));
	else if (taken.settle) out.push("# no previous snapshot to diff against");
	return out;
}

/** The text of `warden ui snapshot`: header, element lines, then (settle) the verdict and the diff. */
export function snapshotText(taken: TakenSnapshot): string {
	return [taken.header, ...taken.lines, ...taken.hints, ...settleLines(taken)].join("\n");
}

export type FoundElements = {
	generation: number;
	header: string;
	lines: string[];
	elements: ElementJson[];
	count: number;
};

/** Every element a selector matches in a fresh snapshot (`nth=` honoured), with refs; bumps the generation and stores the snapshot. */
export async function findElements(
	ctx: CommandContext,
	driver: Driver,
	udid: string,
	selector: ParsedSelector
): Promise<Result<FoundElements, UiError>> {
	const taken = await driver.snapshot();
	if (!taken.success) return { success: false, error: driverUiError(taken.error) };
	const snapshot = taken.data;
	const { generation, refs } = storeSnapshot(ctx, udid, snapshot);
	const matches = resolve(selectorToQuery(selector), indexSnapshot(snapshot));
	return ok({
		generation,
		header: `generation ${generation} · ${matches.length} ${matches.length === 1 ? "match" : "matches"}`,
		lines: matches.map((entry) => {
			const ref = refs.byId.get(entry.element.id);
			return renderEntryLine(entry, ref === undefined ? {} : { ref });
		}),
		elements: matches.map((entry) => elementJson(entry, refs.byId.get(entry.element.id))),
		count: matches.length,
	});
}

/**
 * Store a snapshot as the device's next generation (every snapshot, `find`, and the screen `wait` and `scroll --until`
 * matched). The generation is taken and the file written in one store transaction, so concurrent processes cannot
 * leave an older generation in `last-snapshot.json`.
 */
export function storeSnapshot(
	ctx: Pick<CommandContext, "env" | "now" | "store">,
	udid: string,
	snapshot: Snapshot
): { generation: number; refs: RefTable } {
	return commitGeneration(ctx, udid, (generation) => {
		const refs = assignRefs(snapshot, generation);
		writeLastSnapshot(ctx, udid, { generation, takenAt: ctx.now(), hash: snapshotHash(snapshot), snapshot });
		return { generation, refs };
	});
}
