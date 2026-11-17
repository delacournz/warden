import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareShapes, encodeFrame, FrameReader, GuestClient, MAX_FRAME_BYTES, shapeOf } from "./guest-wire";

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "guest-v6", name), "utf8"));

describe("framing", () => {
	test("encodes a 4-byte big-endian length then the payload", () => {
		const frame = encodeFrame('{"a":1}');
		expect([...frame.subarray(0, 4)]).toEqual([0, 0, 0, 7]);
		expect(frame.subarray(4).toString()).toBe('{"a":1}');
	});

	test("refuses an empty or oversize payload", () => {
		expect(() => encodeFrame("")).toThrow(RangeError);
		expect(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow(RangeError);
	});

	test("reassembles frames split across chunks and glued together", () => {
		const reader = new FrameReader();
		const bytes = Buffer.concat([encodeFrame("one"), encodeFrame("two!")]);
		const out: string[] = [];
		for (const byte of bytes) {
			const pushed = reader.push(Uint8Array.of(byte));
			expect(pushed.kind).toBe("frames");
			if (pushed.kind === "frames") for (const frame of pushed.frames) out.push(frame.toString());
		}
		expect(out).toEqual(["one", "two!"]);
		expect(reader.buffered).toBe(0);
		const glued = new FrameReader().push(bytes);
		expect(glued.kind === "frames" && glued.frames.map(String)).toEqual(["one", "two!"]);
	});

	test("flags a zero or oversize length header", () => {
		expect(new FrameReader().push(Uint8Array.of(0, 0, 0, 0)).kind).toBe("invalid");
		expect(new FrameReader().push(Uint8Array.of(0xff, 0xff, 0xff, 0xff)).kind).toBe("invalid");
	});
});

describe("GuestClient", () => {
	let dir: string | undefined;
	let server: Server | undefined;
	afterEach(() => {
		server?.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		server = undefined;
	});

	async function listen(
		onFrame: (request: unknown, reply: (value: unknown) => void, end: () => void) => void
	): Promise<string> {
		dir = mkdtempSync(join(tmpdir(), "wgw-"));
		const path = join(dir, "g.sock");
		server = createServer((socket) => {
			const reader = new FrameReader();
			socket.on("data", (chunk) => {
				const pushed = reader.push(chunk);
				if (pushed.kind !== "frames") return void socket.destroy();
				for (const frame of pushed.frames)
					onFrame(
						JSON.parse(frame.toString()),
						(value) => socket.write(encodeFrame(JSON.stringify(value))),
						() => socket.destroy()
					);
			});
		});
		await new Promise<void>((resolve) => server?.listen(path, resolve));
		return path;
	}

	async function connected(path: string): Promise<GuestClient> {
		const result = await GuestClient.connect(path, 1000);
		if (!result.ok) throw new Error(JSON.stringify(result.error));
		return result.client;
	}

	test("round-trips a request and queues streamed frames", async () => {
		const path = await listen((request, reply) => {
			reply({ echo: request });
			reply({ second: true });
		});
		const client = await connected(path);
		const first = await client.request({ ping: {} }, 1000);
		expect(first).toEqual({ ok: true, value: { echo: { ping: {} } } });
		expect(await client.next(1000)).toEqual({ ok: true, value: { second: true } });
		client.close();
	});

	test("reports silence as a timeout and a hang-up as closed", async () => {
		const silent = await listen(() => {});
		const quiet = await connected(silent);
		const timedOut = await quiet.request({ ping: {} }, 50);
		expect(timedOut).toEqual({ ok: false, error: { kind: "timeout", afterMs: 50 } });
		quiet.close();
		server?.close();

		const hangup = await listen((_request, _reply, end) => end());
		const dropped = await connected(hangup);
		const closed = await dropped.request({ ping: {} }, 1000);
		expect(closed.ok).toBe(false);
		if (!closed.ok) expect(closed.error.kind).toBe("closed");
	});

	test("a missing socket is a socket error", async () => {
		const result = await GuestClient.connect(join(tmpdir(), "wgw-does-not-exist.sock"), 500);
		expect(result.ok).toBe(false);
	});
});

describe("shape comparison", () => {
	test("shapeOf folds element children into one node schema and arrays into []", () => {
		const shape = shapeOf({
			list: [{ a: 1 }, { a: "x" }],
			XC_kAXXCAttributeChildren: [{ XC_kAXXCAttributeChildren: [] }],
		});
		expect([...(shape.get("$.list[].a") ?? [])].sort()).toEqual(["number", "string"]);
		expect(shape.has("$.XC_kAXXCAttributeChildren")).toBe(true);
		expect(shape.has("$.XC_kAXXCAttributeChildren[]")).toBe(false);
	});

	test("goldens match themselves", () => {
		for (const name of ["describe-frontmost", "hittest", "hittest-empty", "ping", "read-bad-pid", "bad-version"]) {
			const golden = fixture(`${name}.resp.json`);
			expect(compareShapes(golden, golden)).toEqual({ drift: [], added: [] });
		}
	});

	test("different values with the same shape are not drift", () => {
		const golden = fixture("hittest.resp.json");
		const live = JSON.parse(JSON.stringify(golden).replace("Action Button", "Anything").replace("94775", "1"));
		expect(compareShapes(golden, live).drift).toEqual([]);
	});

	test("a changed envelope is drift: answers renamed back to values", () => {
		const golden = fixture("ping.resp.json") as { result: { answers: unknown[] } };
		const live = { ...golden, result: { values: [], exitCode: 0 } };
		const report = compareShapes(golden, live);
		expect(report.drift.map((d) => `${d.problem}:${d.path}`)).toContain("missing:$.result.answers");
		expect(report.added).toContain("$.result.values");
	});

	test("a kind change on a required key is drift", () => {
		const golden = fixture("hittest.resp.json");
		const live = JSON.parse(JSON.stringify(golden).replace('"Height":52', '"Height":"52"'));
		const report = compareShapes(golden, live);
		expect(report.drift).toHaveLength(1);
		expect(report.drift[0]).toMatchObject({ problem: "type", expected: "number", actual: "string" });
	});

	test("an omitted optional node attribute is fine, a missing Frame is not", () => {
		const golden = fixture("hittest.resp.json");
		const noLabel = JSON.parse(JSON.stringify(golden).replace('"XC_kAXXCAttributeLabel":"Action Button",', ""));
		expect(compareShapes(golden, noLabel).drift).toEqual([]);
		const noFrame = JSON.parse(JSON.stringify(golden).replace(/"XC_kAXXCAttributeFrame":\{[^}]*\},/, ""));
		expect(compareShapes(golden, noFrame).drift.length).toBeGreaterThan(0);
	});

	test("ElementType may be a class name or a number", () => {
		const golden = fixture("hittest.resp.json");
		const live = JSON.parse(JSON.stringify(golden).replace('"SwiftUI.AccessibilityNode"', "3"));
		expect(compareShapes(golden, live).drift).toEqual([]);
	});
});
