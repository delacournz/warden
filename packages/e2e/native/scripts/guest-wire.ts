/**
 * idb's in-simulator AX guest wire (protocol v6): a 4-byte big-endian length, then a UTF-8 JSON payload, over a
 * unix socket. Pure framing, a promise-based client and the shape comparison `guest-contract.ts` uses to hold a
 * live guest to the golden frames in `fixtures/guest-v6/`. No simulator is needed to test any of it.
 */
import { createConnection, type Socket } from "node:net";

/** The guest rejects a payload of 0 bytes or more than 16 MiB by closing the connection. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(payload: string | Uint8Array): Buffer {
	const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
	if (body.length === 0 || body.length > MAX_FRAME_BYTES)
		throw new RangeError(`frame of ${body.length} bytes is outside 1..${MAX_FRAME_BYTES}`);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length, 0);
	return Buffer.concat([header, body]);
}

export type PushResult = { kind: "frames"; frames: Buffer[] } | { kind: "invalid"; reason: string };

/** Incremental frame decoder: feed it socket chunks, get whole payloads back. */
export class FrameReader {
	private pending: Buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): PushResult {
		this.pending = Buffer.concat([this.pending, chunk]);
		const frames: Buffer[] = [];
		while (this.pending.length >= 4) {
			const length = this.pending.readUInt32BE(0);
			if (length === 0 || length > MAX_FRAME_BYTES)
				return { kind: "invalid", reason: `frame length ${length} is outside 1..${MAX_FRAME_BYTES}` };
			if (this.pending.length < 4 + length) break;
			frames.push(this.pending.subarray(4, 4 + length));
			this.pending = this.pending.subarray(4 + length);
		}
		return { kind: "frames", frames };
	}

	/** Bytes of an incomplete frame still buffered. */
	get buffered(): number {
		return this.pending.length;
	}
}

export type FrameError =
	| { kind: "timeout"; afterMs: number }
	| { kind: "closed"; midFrame: boolean }
	| { kind: "invalid"; reason: string }
	| { kind: "socket"; message: string };

export type FrameOutcome = { ok: true; value: unknown } | { ok: false; error: FrameError };

type Waiter = { resolve: (outcome: FrameOutcome) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number };

/** One connection to a guest. A guest serves one connection at a time, so requests are strictly sequential. */
export class GuestClient {
	private readonly reader = new FrameReader();
	private readonly queue: unknown[] = [];
	private waiter: Waiter | undefined;
	private failure: FrameError | undefined;

	private constructor(private readonly socket: Socket) {
		socket.on("data", (chunk) => {
			const pushed = this.reader.push(chunk);
			if (pushed.kind === "invalid") return this.fail({ kind: "invalid", reason: pushed.reason });
			for (const frame of pushed.frames) {
				try {
					this.deliver(JSON.parse(frame.toString("utf8")) as unknown);
				} catch {
					return this.fail({ kind: "invalid", reason: "frame is not JSON" });
				}
			}
		});
		socket.on("error", (error) => this.fail({ kind: "socket", message: error.message }));
		socket.on("close", () => this.fail({ kind: "closed", midFrame: this.reader.buffered > 0 }));
	}

	static connect(
		path: string,
		timeoutMs: number
	): Promise<{ ok: true; client: GuestClient } | { ok: false; error: FrameError }> {
		return new Promise((resolve) => {
			const socket = createConnection(path);
			const timer = setTimeout(() => {
				socket.destroy();
				resolve({ ok: false, error: { kind: "timeout", afterMs: timeoutMs } });
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve({ ok: true, client: new GuestClient(socket) });
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				resolve({ ok: false, error: { kind: "socket", message: error.message } });
			});
		});
	}

	private deliver(value: unknown): void {
		const waiter = this.waiter;
		if (!waiter) return void this.queue.push(value);
		this.waiter = undefined;
		clearTimeout(waiter.timer);
		waiter.resolve({ ok: true, value });
	}

	private fail(error: FrameError): void {
		this.failure ??= error;
		const waiter = this.waiter;
		if (!waiter) return;
		this.waiter = undefined;
		clearTimeout(waiter.timer);
		waiter.resolve({ ok: false, error: this.failure });
	}

	send(request: unknown): void {
		this.socket.write(encodeFrame(JSON.stringify(request)));
	}

	/** The next response frame, or why none came. Frames that arrived early are returned first. */
	next(timeoutMs: number): Promise<FrameOutcome> {
		if (this.queue.length > 0) return Promise.resolve({ ok: true, value: this.queue.shift() });
		if (this.failure) return Promise.resolve({ ok: false, error: this.failure });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiter = undefined;
				resolve({ ok: false, error: { kind: "timeout", afterMs: timeoutMs } });
			}, timeoutMs);
			this.waiter = { resolve, timer, timeoutMs };
		});
	}

	async request(request: unknown, timeoutMs: number): Promise<FrameOutcome> {
		this.send(request);
		return this.next(timeoutMs);
	}

	close(): void {
		this.socket.destroy();
	}
}

/** JSON kinds a value can have; integers and floats are both `number`. */
export type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";

export function kindOf(value: unknown): Kind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "boolean":
			return "boolean";
		case "number":
			return "number";
		case "string":
			return "string";
		default:
			return "object";
	}
}

/** A tree node's recursion key: its children are folded into the same path, so every depth is one node schema. */
const CHILDREN_KEY = "XC_kAXXCAttributeChildren";

/** Path (array elements `[]`, node children folded) to the kinds seen there. */
export type Shape = Map<string, Set<Kind>>;

export function shapeOf(value: unknown): Shape {
	const shape: Shape = new Map();
	const visit = (node: unknown, path: string): void => {
		const kind = kindOf(node);
		const kinds = shape.get(path) ?? new Set<Kind>();
		shape.set(path, kinds);
		kinds.add(kind);
		if (Array.isArray(node)) {
			const elementPath = path.endsWith(`.${CHILDREN_KEY}`) ? path.slice(0, -CHILDREN_KEY.length - 1) : `${path}[]`;
			for (const element of node) visit(element, elementPath);
		} else if (kind === "object") {
			for (const [key, child] of Object.entries(node as Record<string, unknown>)) visit(child, `${path}.${key}`);
		}
	};
	visit(value, "$");
	return shape;
}

/** Node attributes every element carries; everything else under an `XC_`/`FB` key may be omitted on the wire. */
const REQUIRED_NODE_KEYS = new Set(["XC_kAXXCAttributeElementType", "XC_kAXXCAttributeFrame"]);

/** True when the path runs through a node attribute the guest may omit from any element. */
function isOptionalPath(path: string): boolean {
	const key = path.split(".").find((segment) => segment.startsWith("XC_kAXXCAttribute") || segment.startsWith("FB"));
	return key !== undefined && !REQUIRED_NODE_KEYS.has(key);
}

/** Class-name string or number, per the wire doc: either is fine. */
const EITHER_STRING_OR_NUMBER = [".XC_kAXXCAttributeElementType", ".XC_kAXXCAttributeAutomationType"];

export type Drift = { path: string; problem: "missing" | "type"; expected: string; actual: string };

export type ShapeReport = { drift: Drift[]; added: string[] };

function kindsText(kinds: Set<Kind> | undefined): string {
	return kinds ? [...kinds].sort().join("|") : "absent";
}

/**
 * Compares a live response to a golden one by keys and kinds, never values. A path the golden has and the live
 * response lacks is drift unless it is an optional node attribute; a path whose live kind is not one the golden
 * saw is drift. New live paths are reported in `added` and are not drift (a guest may add fields).
 */
export function compareShapes(golden: unknown, live: unknown): ShapeReport {
	const want = shapeOf(golden);
	const have = shapeOf(live);
	const drift: Drift[] = [];
	for (const [path, kinds] of want) {
		const seen = have.get(path);
		if (!seen) {
			if (!isOptionalPath(path)) drift.push({ path, problem: "missing", expected: kindsText(kinds), actual: "absent" });
			continue;
		}
		const flexible = EITHER_STRING_OR_NUMBER.some((suffix) => path.endsWith(suffix));
		const allowed = new Set<Kind>(kinds);
		if (flexible) for (const kind of ["string", "number"] as const) allowed.add(kind);
		const wrong = [...seen].filter((kind) => !allowed.has(kind));
		if (wrong.length > 0) drift.push({ path, problem: "type", expected: kindsText(kinds), actual: kindsText(seen) });
	}
	const added = [...have.keys()].filter((path) => !want.has(path)).sort();
	return { drift, added };
}
