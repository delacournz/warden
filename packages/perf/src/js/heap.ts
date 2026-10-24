import { z } from "zod";
import type { ReportSection } from "../shared/render-md";
import { isUnsupported, type JsCdp, type JsResult, jsErr, jsOk } from "./js.types";

export const HEAP_TOP = 15;

/** A snapshot bigger than this is kept on disk but not parsed (`JSON.parse` of it would exhaust memory). */
export const MAX_PARSE_BYTES = 256 * 1024 * 1024;

const SNAPSHOT_TIMEOUT_MS = 180_000;

const NO_HEAP_HINT =
	"this Hermes build has no HeapProfiler snapshot support: use a dev client on a recent React Native (Hermes with the Fusebox debugger)";

export type HeapCapture = { bytes: number; chunks: number };

/**
 * `HeapProfiler.takeHeapSnapshot`, handing every `addHeapSnapshotChunk` to `onChunk` as it arrives (so a
 * 100MB snapshot streams to disk instead of piling up here). The snapshot freezes the JS thread while it runs.
 */
export async function takeHeapSnapshot(cdp: JsCdp, onChunk: (chunk: string) => void): Promise<JsResult<HeapCapture>> {
	let bytes = 0;
	let chunks = 0;
	const off = cdp.onCdp("HeapProfiler.addHeapSnapshotChunk", (params) => {
		const chunk = typeof params === "object" && params !== null && "chunk" in params ? params.chunk : undefined;
		if (typeof chunk !== "string") return;
		bytes += Buffer.byteLength(chunk);
		chunks++;
		onChunk(chunk);
	});
	try {
		await cdp.send("HeapProfiler.enable");
		const taken = await cdp.send(
			"HeapProfiler.takeHeapSnapshot",
			{ reportProgress: false },
			{ timeoutMs: SNAPSHOT_TIMEOUT_MS }
		);
		if (!taken.success) {
			return isUnsupported(taken.error)
				? jsErr("unsupported", `HeapProfiler.takeHeapSnapshot: ${taken.error.message}`, NO_HEAP_HINT)
				: jsErr("cdp_failed", `HeapProfiler.takeHeapSnapshot: ${taken.error.message}`);
		}
		if (chunks === 0) return jsErr("unsupported", "the runtime sent no snapshot chunks", NO_HEAP_HINT);
		return jsOk({ bytes, chunks });
	} finally {
		off();
		await cdp.send("HeapProfiler.disable");
	}
}

const snapshotSchema = z.looseObject({
	snapshot: z.looseObject({
		meta: z.looseObject({
			node_fields: z.array(z.string()),
			node_types: z.array(z.unknown()),
		}),
	}),
	nodes: z.array(z.number()),
	strings: z.array(z.string()),
});

export type ConstructorStat = { name: string; count: number; selfSize: number };

export type ParsedHeap = {
	nodeCount: number;
	totalSelfSize: number;
	/** every constructor, largest self size first */
	constructors: ConstructorStat[];
};

/**
 * Group a V8-format heap snapshot by constructor: `object` / `native` nodes by their name, every other node type
 * as `(type)`. Sizes are self sizes; retained sizes need a dominator tree and are not computed.
 */
export function parseHeapSnapshot(text: string): JsResult<ParsedHeap> {
	if (text.length > MAX_PARSE_BYTES) {
		return jsErr(
			"too_large",
			`snapshot is ${Math.round(text.length / 1024 / 1024)}MiB: too big to summarize here`,
			"open the .heapsnapshot in Chrome DevTools (Memory tab)"
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return jsErr("invalid_snapshot", "not a JSON heap snapshot");
	}
	const parsed = snapshotSchema.safeParse(raw);
	if (!parsed.success) return jsErr("invalid_snapshot", "heap snapshot has no meta/nodes/strings");
	const { nodes, strings } = parsed.data;
	const { node_fields: fields, node_types: types } = parsed.data.snapshot.meta;
	const typeAt = fields.indexOf("type");
	const nameAt = fields.indexOf("name");
	const sizeAt = fields.indexOf("self_size");
	const typeNames = Array.isArray(types[0]) ? types[0].map(String) : [];
	if (typeAt < 0 || nameAt < 0 || sizeAt < 0)
		return jsErr("invalid_snapshot", "heap snapshot lacks type/name/self_size fields");
	return jsOk(groupNodes(nodes, strings, { stride: fields.length, typeAt, nameAt, sizeAt, typeNames }));
}

type NodeLayout = { stride: number; typeAt: number; nameAt: number; sizeAt: number; typeNames: string[] };

function groupNodes(nodes: readonly number[], strings: readonly string[], layout: NodeLayout): ParsedHeap {
	const { stride, typeAt, nameAt, sizeAt, typeNames } = layout;
	const groups = new Map<string, ConstructorStat>();
	let totalSelfSize = 0;
	let nodeCount = 0;
	for (let i = 0; i + stride <= nodes.length; i += stride) {
		const type = typeNames[nodes[i + typeAt] ?? -1] ?? "unknown";
		const size = nodes[i + sizeAt] ?? 0;
		const name =
			type === "object" || type === "native" ? strings[nodes[i + nameAt] ?? -1] || "(anonymous)" : `(${type})`;
		const group = groups.get(name) ?? { name, count: 0, selfSize: 0 };
		group.count++;
		group.selfSize += size;
		groups.set(name, group);
		totalSelfSize += size;
		nodeCount++;
	}
	const constructors = [...groups.values()].sort((a, b) => b.selfSize - a.selfSize);
	return { nodeCount, totalSelfSize, constructors };
}

export type HeapSummary = {
	nodeCount: number;
	totalSelfSize: number;
	topBySize: ConstructorStat[];
	topByCount: ConstructorStat[];
};

/** The top constructors by self size and by count. */
export function summarizeHeap(heap: ParsedHeap, top = HEAP_TOP): HeapSummary {
	return {
		nodeCount: heap.nodeCount,
		totalSelfSize: heap.totalSelfSize,
		topBySize: heap.constructors.slice(0, top),
		topByCount: [...heap.constructors].sort((a, b) => b.count - a.count).slice(0, top),
	};
}

export type ConstructorDelta = {
	name: string;
	countA: number;
	countB: number;
	countDelta: number;
	sizeA: number;
	sizeB: number;
	sizeDelta: number;
};

export type HeapDiff = {
	nodeCountDelta: number;
	totalSizeDelta: number;
	/** largest size growth first; constructors that did not change are left out */
	rows: ConstructorDelta[];
};

/** Constructor count and self-size deltas from snapshot `a` (before) to `b` (after). */
export function diffHeaps(a: ParsedHeap, b: ParsedHeap, top = HEAP_TOP): HeapDiff {
	const before = new Map(a.constructors.map((c) => [c.name, c]));
	const after = new Map(b.constructors.map((c) => [c.name, c]));
	const rows: ConstructorDelta[] = [];
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		const x = before.get(name);
		const y = after.get(name);
		const row: ConstructorDelta = {
			name,
			countA: x?.count ?? 0,
			countB: y?.count ?? 0,
			countDelta: (y?.count ?? 0) - (x?.count ?? 0),
			sizeA: x?.selfSize ?? 0,
			sizeB: y?.selfSize ?? 0,
			sizeDelta: (y?.selfSize ?? 0) - (x?.selfSize ?? 0),
		};
		if (row.countDelta !== 0 || row.sizeDelta !== 0) rows.push(row);
	}
	rows.sort((p, q) => Math.abs(q.sizeDelta) - Math.abs(p.sizeDelta) || Math.abs(q.countDelta) - Math.abs(p.countDelta));
	return {
		nodeCountDelta: b.nodeCount - a.nodeCount,
		totalSizeDelta: b.totalSelfSize - a.totalSelfSize,
		rows: rows.slice(0, top),
	};
}

export function formatBytes(n: number): string {
	const abs = Math.abs(n);
	const sign = n < 0 ? "-" : "";
	if (abs < 1024) return `${n}B`;
	if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KiB`;
	return `${sign}${(abs / 1024 / 1024).toFixed(1)}MiB`;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function heapSection(summary: HeapSummary): ReportSection {
	const line = (c: ConstructorStat, i: number): string =>
		`${String(i + 1).padStart(2)}. ${c.name}  ${formatBytes(c.selfSize)}  x${c.count}`;
	return {
		title: "Heap snapshot",
		lines: [
			`${summary.nodeCount} objects · ${formatBytes(summary.totalSelfSize)} self size (retained sizes: open the file in Chrome DevTools)`,
			"",
			"top constructors by self size:",
			...summary.topBySize.map(line),
			"",
			"top constructors by count:",
			...summary.topByCount.map(line),
		],
	};
}

export function heapDiffSection(diff: HeapDiff): ReportSection {
	return {
		title: "Heap diff",
		lines: [
			`${signed(diff.nodeCountDelta)} objects · ${diff.totalSizeDelta >= 0 ? "+" : ""}${formatBytes(diff.totalSizeDelta)} self size`,
			...diff.rows.map(
				(r, i) =>
					`${String(i + 1).padStart(2)}. ${r.name}  ${r.sizeDelta >= 0 ? "+" : ""}${formatBytes(r.sizeDelta)}  ${signed(r.countDelta)} (${r.countA} -> ${r.countB})`
			),
		],
	};
}
