import type { Driver, Element, Rect, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { assignRefs, type RefTable } from "@delacour/warden-e2e/driver/refs";
import { settleByHash, snapshotHash } from "@delacour/warden-e2e/driver/settle";
import { indexSnapshot, type NodeEntry } from "@delacour/warden-e2e/screen/nodes";
import { resolve } from "@delacour/warden-e2e/screen/query";
import { renderEntryLine, renderSnapshot } from "@delacour/warden-e2e/screen/render";
import { isInteractiveRole } from "@delacour/warden-e2e/screen/roles";
import { type ParsedSelector, selectorToQuery } from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { diffSnapshots, renderDiff, type SnapshotDiff } from "./diff";
import { driverUiError, type UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { bumpGeneration, preorder, readLastSnapshot, writeLastSnapshot } from "./state";

/** Lines printed by a plain `snapshot` before `… N more (use --all)`. */
export const DEFAULT_MAX_LINES = 200;
/** `--settle` with no value waits at most this long for a quiet screen. */
export const DEFAULT_SETTLE_BUDGET_MS = 3000;
/** The screen counts as settled once the hash stayed equal for this long. */
export const SETTLE_QUIET_MS = 250;

export type SnapshotRequest = {
	/** `-i`: interactive roles and anything with a testID */
	interactiveOnly: boolean;
	/** `--all`: no line cap */
	all: boolean;
	/** `--depth n`: only the first n levels of the tree */
	depth?: number;
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
};

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

/** The entries `renderSnapshot` lists with `interactiveOnly` (same rule as screen/render.ts). */
function isListed(entry: NodeEntry): boolean {
	if (entry.states.hidden) return false;
	const id = entry.element.identifier;
	return isInteractiveRole(entry.role) || (id !== undefined && id !== "");
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

export function snapshotHeader(snapshot: Snapshot, generation: number, shown: number, total: number): string {
	const { width, height, scale } = snapshot.screen;
	const count = shown === total ? `${total} elements` : `${shown} of ${total} elements`;
	return (
		[`generation ${generation}`, snapshot.backend, `${width}×${height}@${scale}x`, count].join(" · ") +
		(snapshot.truncated ? ", truncated" : "")
	);
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
			quietMs: SETTLE_QUIET_MS,
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
	const { snapshot } = fetched.data;
	const generation = bumpGeneration(ctx, udid);
	const refs = assignRefs(snapshot, generation);
	const hash = snapshotHash(snapshot);
	writeLastSnapshot(ctx, udid, { generation, takenAt: ctx.now(), hash, snapshot });

	const view = request.depth === undefined ? snapshot : pruneDepth(snapshot, request.depth);
	const rendered = renderSnapshot(view, {
		interactiveOnly: request.interactiveOnly,
		refs: refs.byId,
		...(request.all ? {} : { maxLines: DEFAULT_MAX_LINES }),
	});
	const entries = indexSnapshot(view).entries;
	const listed = (request.interactiveOnly ? entries.filter(isListed) : entries).slice(0, rendered.shown);
	const taken: TakenSnapshot = {
		snapshot,
		refs,
		hash,
		generation,
		header: snapshotHeader(view, generation, rendered.shown, rendered.total),
		lines: rendered.lines,
		elements: listed.map((entry) => elementJson(entry, refs.byId.get(entry.element.id))),
		total: rendered.total,
		shown: rendered.shown,
		omitted: rendered.omitted,
	};
	if (fetched.data.settle) taken.settle = fetched.data.settle;
	if (request.settle && previous) {
		taken.diff = { ...diffSnapshots(previous.snapshot, snapshot, refs.byId), against: previous.generation };
	}
	return ok(taken);
}

/** The text of `warden ui snapshot`: header, element lines, then (settle) the verdict and the diff. */
export function snapshotText(taken: TakenSnapshot): string {
	const out = [taken.header, ...taken.lines];
	if (taken.settle) {
		out.push(
			taken.settle.quiet
				? `# settled after ${taken.settle.waitedMs} ms`
				: `# not quiet after ${taken.settle.waitedMs} ms (gave up)`
		);
	}
	if (taken.diff) out.push(`# diff vs generation ${taken.diff.against}`, ...renderDiff(taken.diff));
	else if (taken.settle) out.push("# no previous snapshot to diff against");
	return out.join("\n");
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
	const generation = bumpGeneration(ctx, udid);
	const refs = assignRefs(snapshot, generation);
	writeLastSnapshot(ctx, udid, { generation, takenAt: ctx.now(), hash: snapshotHash(snapshot), snapshot });
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
