import type { CpuProfile } from "./cpu-profile";
import type { JsCdp } from "./js.types";

export type FakeCdp = JsCdp & {
	sent: Array<{ method: string; params: Record<string, unknown> | undefined }>;
	emit: (method: string, params: unknown) => void;
};

type ReplyFn = (params: Record<string, unknown> | undefined) => unknown;
type Reply = object | string | number | boolean | null | ReplyFn;

/** A scripted CDP session: `replies[method]` is the result (or `{ __error }`), `events[method]` fires after that call. */
export function fakeCdp(replies: Record<string, Reply> = {}, events: Record<string, unknown[]> = {}): FakeCdp {
	const handlers = new Map<string, Set<(params: unknown) => void>>();
	const sent: FakeCdp["sent"] = [];
	const emit = (method: string, params: unknown) => {
		for (const handler of handlers.get(method) ?? []) handler(params);
	};
	return {
		sent,
		emit,
		async send(method, params) {
			sent.push({ method, params });
			for (const eventParams of events[method] ?? []) emit(eventNameFor(method), eventParams);
			const reply = replies[method];
			const value = typeof reply === "function" ? reply(params) : reply;
			if (typeof value === "object" && value !== null && "__error" in value) {
				return { success: false, error: { code: "cdp_error", message: String(value.__error) } };
			}
			return { success: true, data: value ?? {} };
		},
		onCdp(method, handler) {
			const set = handlers.get(method) ?? new Set<(params: unknown) => void>();
			handlers.set(method, set);
			set.add(handler);
			return () => set.delete(handler);
		},
	};
}

/** Which event a call triggers: `Debugger.enable` replays `Debugger.scriptParsed`, a snapshot streams chunks. */
function eventNameFor(method: string): string {
	if (method === "Debugger.enable") return "Debugger.scriptParsed";
	if (method === "HeapProfiler.takeHeapSnapshot") return "HeapProfiler.addHeapSnapshotChunk";
	return method;
}

type NodeSpec = {
	id: number;
	name: string;
	url?: string;
	scriptId?: string;
	line?: number;
	column?: number;
	children?: number[];
};

/** A profile from node specs and `[nodeId, deltaUs]` samples (the delta is the gap before that sample). */
export function buildProfile(nodes: NodeSpec[], samples: Array<[number, number]>): CpuProfile {
	return {
		nodes: nodes.map((n) => ({
			id: n.id,
			callFrame: {
				functionName: n.name,
				scriptId: n.scriptId ?? "1",
				url: n.url ?? "",
				lineNumber: n.line ?? 0,
				columnNumber: n.column ?? 0,
			},
			...(n.children ? { children: n.children } : {}),
		})),
		startTime: 1_000,
		endTime: 1_000 + samples.reduce((sum, [, d]) => sum + d, 0),
		samples: samples.map(([id]) => id),
		timeDeltas: samples.map(([, d]) => d),
	};
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
	let v = value < 0 ? (-value << 1) | 1 : value << 1;
	let out = "";
	do {
		let digit = v & 31;
		v >>>= 5;
		if (v > 0) digit |= 32;
		out += B64[digit];
	} while (v > 0);
	return out;
}

type Segment = [genCol: number, sourceIndex: number, srcLine: number, srcCol: number];

/** A source map (version 3) whose generated line `n` has the given segments (all 0-based). */
export function buildSourceMap(sources: string[], lines: Segment[][]): string {
	let sourceIndex = 0;
	let srcLine = 0;
	let srcCol = 0;
	const mappings = lines
		.map((segments) => {
			let genCol = 0;
			return segments
				.map(([g, s, l, c]) => {
					const seg = vlq(g - genCol) + vlq(s - sourceIndex) + vlq(l - srcLine) + vlq(c - srcCol);
					genCol = g;
					sourceIndex = s;
					srcLine = l;
					srcCol = c;
					return seg;
				})
				.join(",");
		})
		.join(";");
	return JSON.stringify({ version: 3, sources, names: [], mappings });
}

/** A V8-format heap snapshot of `[type, name, selfSize]` nodes. */
export function buildHeapSnapshot(nodes: Array<[type: string, name: string, size: number]>): string {
	const types = ["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"];
	const strings: string[] = [];
	const flat: number[] = [];
	nodes.forEach(([type, name, size], i) => {
		let at = strings.indexOf(name);
		if (at < 0) at = strings.push(name) - 1;
		flat.push(types.indexOf(type), at, i + 1, size, 0, 0, 0);
	});
	return JSON.stringify({
		snapshot: {
			meta: {
				node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
				node_types: [types, "string", "number", "number", "number", "number", "number"],
			},
			node_count: nodes.length,
		},
		nodes: flat,
		edges: [],
		strings,
	});
}
