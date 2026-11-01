import type { Driver, Element, Rect, ScreenInfo, Snapshot } from "@delacour/warden-driver/driver.types";
import { type RefTable, refResolver } from "@delacour/warden-driver/refs";
import { DEFAULT_SETTLE_QUIET_MS, settler } from "@delacour/warden-driver/settle";
import { type NodeEntry, nodeIndexer } from "@delacour/warden-screen/nodes";
import { queryResolver } from "@delacour/warden-screen/query";
import { snapshotRenderer } from "@delacour/warden-screen/render";
import { roleResolver } from "@delacour/warden-screen/roles";
import { type ParsedSelector, selectorEngine } from "@delacour/warden-screen/selector";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { diffSnapshots, renderDiff, type SnapshotDiff } from "./diff";
import { driverError, fail, opError } from "./errors";
import { preorder } from "./ref-store";
import type { OpOutcome, OpSession } from "./session";

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

export function elementJson(entry: NodeEntry, ref: string | undefined): ElementJson {
	const { element, states } = entry;
	return {
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

type Fetched = { snapshot: Snapshot; settle?: { quiet: boolean; waitedMs: number } };

async function fetchSnapshot(
	session: OpSession,
	driver: Driver,
	settle: SnapshotRequest["settle"]
): Promise<Result<Fetched, WardenError>> {
	if (settle === undefined) {
		const taken = await driver.snapshot();
		return taken.success ? resultFactory.ok({ snapshot: taken.data }) : fail(driverError(taken.error));
	}
	let latest: Snapshot | undefined;
	let failure: WardenError | undefined;
	const poll = async (): Promise<string> => {
		const taken = await driver.snapshot();
		if (!taken.success) {
			failure = driverError(taken.error);
			throw new Error(taken.error.message);
		}
		latest = taken.data;
		return settler.snapshotHash(taken.data);
	};
	try {
		const outcome = await settler.byHash(poll, {
			quietMs: DEFAULT_SETTLE_QUIET_MS,
			timeoutMs: settle.budgetMs,
			now: session.host.now,
			sleep: session.host.sleep,
		});
		return latest ? resultFactory.ok({ snapshot: latest, settle: outcome }) : fail(opError("failed", "no snapshot"));
	} catch (error) {
		return fail(failure ?? opError("failed", error instanceof Error ? error.message : String(error)));
	}
}

/**
 * Take a snapshot of the device, give it the next generation and `@eN` refs, store it in the session's
 * {@link RefStore} and render it. With `settle`, polls until the screen hash stays equal for 250 ms
 * (or the budget runs out: `settle.quiet === false`) and diffs against the previously stored snapshot.
 * Refs are numbered over the whole tree, so `-i`, `--depth` and `--all` print the same `@eN` for the same element.
 */
export async function takeSnapshot(
	session: OpSession,
	driver: Driver,
	request: SnapshotRequest
): Promise<Result<TakenSnapshot, WardenError>> {
	const previous = session.refs.last();
	const fetched = await fetchSnapshot(session, driver, request.settle);
	if (!fetched.success) return fetched;
	const { snapshot } = fetched.data;
	const { generation, refs } = storeSnapshot(session, snapshot);
	const hash = settler.snapshotHash(snapshot);

	const view = request.depth === undefined ? snapshot : pruneDepth(snapshot, request.depth);
	const rendered = snapshotRenderer.renderSnapshot(view, {
		interactiveOnly: request.interactiveOnly,
		refs: refs.byId,
		...(request.all ? {} : { maxLines: DEFAULT_MAX_LINES }),
	});
	const entries = nodeIndexer.indexSnapshot(view).entries;
	const listed = (
		request.interactiveOnly ? entries.filter((entry) => snapshotRenderer.isListed(entry)) : entries
	).slice(0, rendered.shown);
	const unmarked = (entry: NodeEntry): boolean =>
		request.markMissingIds === true &&
		request.interactiveOnly &&
		roleResolver.isInteractiveRole(entry.role) &&
		(entry.element.identifier === undefined || entry.element.identifier === "");
	const lines = rendered.lines.map((line, at) => {
		const entry = listed[at];
		return entry !== undefined && unmarked(entry) ? `${line} ${NO_ID_MARK}` : line;
	});
	const taken: TakenSnapshot = {
		snapshot,
		refs,
		hash,
		generation,
		header: snapshotRenderer.renderHeader({
			snapshot: view,
			rendered,
			interactiveOnly: request.interactiveOnly,
			generation,
			style: "cli",
		}),
		lines,
		elements: listed.map((entry) => ({
			...elementJson(entry, refs.byId.get(entry.element.id)),
			...(unmarked(entry) ? { noId: true as const } : {}),
		})),
		hints: missingIdHints(listed.filter(unmarked).length),
		total: rendered.total,
		shown: rendered.shown,
		omitted: rendered.omitted,
	};
	if (fetched.data.settle) taken.settle = fetched.data.settle;
	if (request.settle && previous) {
		taken.diff = { ...diffSnapshots(previous.snapshot, snapshot, refs.byId), against: previous.generation };
	}
	return resultFactory.ok(taken);
}

/** The advice under a `-i` snapshot taken during a recording: how many elements lack a testID. */
function missingIdHints(missing: number): string[] {
	if (missing === 0) return [];
	return [
		`# ${missing} interactive element${missing === 1 ? "" : "s"} marked ${NO_ID_MARK}: add testID + accessible in the component, reload, \`record undo\` and redo — a text selector breaks with the copy`,
	];
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
	session: OpSession,
	driver: Driver,
	selector: ParsedSelector
): Promise<Result<FoundElements, WardenError>> {
	const taken = await driver.snapshot();
	if (!taken.success) return fail(driverError(taken.error));
	const snapshot = taken.data;
	const { generation, refs } = storeSnapshot(session, snapshot);
	const matches = queryResolver.resolve(selectorEngine.selectorToQuery(selector), nodeIndexer.indexSnapshot(snapshot));
	return resultFactory.ok({
		generation,
		header: `generation ${generation} · ${matches.length} ${matches.length === 1 ? "match" : "matches"}`,
		lines: matches.map((entry) => {
			const ref = refs.byId.get(entry.element.id);
			return snapshotRenderer.renderEntryLine(entry, ref === undefined ? {} : { ref });
		}),
		elements: matches.map((entry) => elementJson(entry, refs.byId.get(entry.element.id))),
		count: matches.length,
	});
}

/**
 * Store a snapshot as the device's next generation (every snapshot, `find`, and the screen `wait` and `scroll --until`
 * matched). The generation is taken and the snapshot stored in one {@link RefStore} commit, so concurrent writers
 * cannot leave an older generation behind.
 */
export function storeSnapshot(session: OpSession, snapshot: Snapshot): { generation: number; refs: RefTable } {
	const stored = session.refs.commit({ takenAt: session.host.now(), hash: settler.snapshotHash(snapshot), snapshot });
	return { generation: stored.generation, refs: refResolver.assign(snapshot, stored.generation) };
}

// ---- ops ---------------------------------------------------------------------------------------------------------

export type SnapshotParams = {
	/** only interactive elements and anything with a testID */
	interactiveOnly?: boolean;
	/** no line cap */
	all?: boolean;
	/** only the first n levels of the tree */
	depth?: number;
	/** mark interactive elements without a testID `[no-id]` (needs `interactiveOnly`; the CLI sets it while a recording is active) */
	markMissingIds?: boolean;
	/** wait for a quiet screen for up to this many ms, then diff against the previous snapshot */
	settleMs?: number;
};

export type SnapshotOpResult = {
	backend: Snapshot["backend"];
	screen: ScreenInfo;
	truncated: boolean;
	hash: string;
	generation: number;
	elements: ElementJson[];
	total: number;
	shown: number;
	omitted: number;
	settle: { quiet: boolean; waitedMs: number } | null;
	diff: (SnapshotDiff & { against: number }) | null;
};

/** `warden ui snapshot`: the screen as `@eN` lines; bumps the generation. */
export async function snapshot(session: OpSession, params: SnapshotParams = {}): OpOutcome<SnapshotOpResult> {
	const request: SnapshotRequest = { interactiveOnly: params.interactiveOnly === true, all: params.all === true };
	if (params.depth !== undefined) request.depth = params.depth;
	if (params.markMissingIds === true) request.markMissingIds = true;
	if (params.settleMs !== undefined) request.settle = { budgetMs: params.settleMs };
	const driver = await session.driver();
	if (!driver.success) return driver;
	const taken = await takeSnapshot(session, driver.data, request);
	if (!taken.success) return taken;
	const data = taken.data;
	return resultFactory.ok({
		generation: data.generation,
		text: snapshotText(data),
		warnings: data.settle && !data.settle.quiet ? ["screen did not settle within the budget"] : [],
		result: {
			backend: data.snapshot.backend,
			screen: data.snapshot.screen,
			truncated: data.snapshot.truncated,
			hash: data.hash,
			generation: data.generation,
			elements: data.elements,
			total: data.total,
			shown: data.shown,
			omitted: data.omitted,
			settle: data.settle ?? null,
			diff: data.diff ?? null,
		},
	});
}

export type FindParams = {
	/** `id=… label=… text=… role=… value=… editable=… nth=…` */
	selector: string;
};

export type FindResult = { count: number; elements: ElementJson[] };

/** `warden ui find`: elements matching a selector, with refs; bumps the generation. */
export async function find(session: OpSession, params: FindParams): OpOutcome<FindResult> {
	const selector = selectorEngine.parseSelector(params.selector);
	if (!selector.success) return fail(opError("usage", `bad selector: ${selector.error}`));
	const driver = await session.driver();
	if (!driver.success) return driver;
	const found = await findElements(session, driver.data, selector.data);
	if (!found.success) return found;
	return resultFactory.ok({
		generation: found.data.generation,
		text: [found.data.header, ...found.data.lines].join("\n"),
		result: { count: found.data.count, elements: found.data.elements },
	});
}
