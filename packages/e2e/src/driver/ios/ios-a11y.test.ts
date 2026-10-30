import { describe, expect, test } from "bun:test";
import { el, snap } from "../../screen/element.testing";
import { createInjectChannel, type InjectFs, injectA11yPath } from "./inject";
import { createIosA11y, type IosA11yNode, mergeA11y, parseA11yDump } from "./ios-a11y";

const node = (over: Partial<IosA11yNode> = {}): IosA11yNode => ({
	cls: "UIView",
	element: true,
	traits: 0n,
	frame: { x: 0, y: 0, width: 100, height: 40 },
	actions: [],
	...over,
});

describe("parseA11yDump", () => {
	test("reads nodes, hex traits beyond 2^53 and optional fields", () => {
		const text = JSON.stringify({
			req: 7,
			nodes: [
				{
					cls: "RCTSwitch",
					ae: true,
					label: "Dark mode",
					hint: "Toggles",
					value: "1",
					id: "settings-dark-mode",
					traits: "0x20000000000001",
					frame: [10, 20, 51, 31],
					actions: ["activate"],
					order: 2,
				},
				{ cls: "UIView", ae: false, traits: "0x0", frame: [0, 0, 1, 1] },
			],
		});
		const parsed = parseA11yDump(text, 7);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data[0]).toEqual({
			cls: "RCTSwitch",
			element: true,
			label: "Dark mode",
			hint: "Toggles",
			value: "1",
			identifier: "settings-dark-mode",
			traits: 0x20000000000001n,
			frame: { x: 10, y: 20, width: 51, height: 31 },
			actions: ["activate"],
			order: 2,
		});
		expect(parsed.data[1]).toMatchObject({ element: false, actions: [] });
	});

	test("rejects a dump for another request, junk, and an app-side error", () => {
		expect(parseA11yDump('{"req":1,"nodes":[]}', 2)).toMatchObject({ success: false });
		expect(parseA11yDump("nope", 1)).toMatchObject({ success: false });
		expect(parseA11yDump('{"req":1,"nodes":[{"ae":true}]}', 1)).toMatchObject({ success: false });
		const busy = parseA11yDump('{"req":1,"error":"main thread busy"}', 1);
		expect(busy.success ? "" : busy.error).toContain("main thread busy");
		const mac = parseA11yDump('{"req":1,"nodes":[],"unsupported":true}', 1);
		expect(mac.success ? "" : mac.error).toContain("not iOS");
	});
});

describe("mergeA11y (identifier first, then frame overlap)", () => {
	test("matches by identifier even when the frames differ, and fills every fact", () => {
		const snapshot = snap([el("button", { identifier: "save", frame: { x: 0, y: 0, width: 100, height: 40 } })]);
		const merged = mergeA11y(snapshot, [
			node({
				identifier: "save",
				hint: "Saves",
				actions: ["Archive"],
				order: 1,
				frame: { x: 300, y: 300, width: 5, height: 5 },
			}),
		]);
		expect(merged.matched).toBe(1);
		expect(merged.snapshot.flat[0]?.a11y).toEqual({
			hint: "Saves",
			actions: ["Archive"],
			focusable: true,
			important: true,
			order: 1,
			traversal: 0,
		});
	});

	test("traversal is the node's position in the walk (VoiceOver's own order)", () => {
		const snapshot = snap([
			el("button", { identifier: "a", frame: { x: 0, y: 0, width: 100, height: 40 } }),
			el("button", { identifier: "b", frame: { x: 0, y: 100, width: 100, height: 40 } }),
		]);
		const merged = mergeA11y(snapshot, [node({ identifier: "b" }), node({ identifier: "a" })]);
		expect(merged.snapshot.flat.map((e) => e.a11y?.traversal)).toEqual([1, 0]);
	});

	test("falls back to frame overlap for elements without a usable identifier", () => {
		const snapshot = snap([
			el("text", { label: "Hello", frame: { x: 10, y: 10, width: 100, height: 20 } }),
			el("text", { label: "Far", frame: { x: 10, y: 400, width: 100, height: 20 } }),
		]);
		const merged = mergeA11y(snapshot, [node({ hint: "near", frame: { x: 12, y: 10, width: 100, height: 20 } })]);
		expect(merged.snapshot.flat[0]?.a11y?.hint).toBe("near");
		expect(merged.snapshot.flat[1]?.a11y).toBeUndefined();
		expect(merged).toMatchObject({ matched: 1, unmatched: 1 });
	});

	test("a node with another identifier never matches by frame; each node is used once", () => {
		const snapshot = snap([
			el("button", { identifier: "a", frame: { x: 0, y: 0, width: 100, height: 40 } }),
			el("button", { frame: { x: 0, y: 0, width: 100, height: 40 } }),
		]);
		const merged = mergeA11y(snapshot, [
			node({ identifier: "other", hint: "x" }),
			node({ identifier: "a", hint: "mine" }),
		]);
		expect(merged.snapshot.flat[0]?.a11y?.hint).toBe("mine");
		expect(merged.snapshot.flat[1]?.a11y).toBeUndefined();
	});

	test("a non-accessibility container (isAccessibilityElement false) reads as not focusable and not important", () => {
		const merged = mergeA11y(snap([el("other", { identifier: "box" })]), [node({ identifier: "box", element: false })]);
		expect(merged.snapshot.flat[0]?.a11y).toEqual({ focusable: false, important: false, traversal: 0 });
	});

	test("does not mutate the input snapshot and keeps tree and flat in step", () => {
		const snapshot = snap([el("other", { identifier: "r" }, [el("button", { identifier: "c" })])]);
		const merged = mergeA11y(snapshot, [node({ identifier: "c", hint: "h" })]);
		expect(snapshot.flat[1]?.a11y).toBeUndefined();
		expect(merged.snapshot.elements[0]?.children[0]).toBe(merged.snapshot.flat[1]);
		expect(merged.snapshot.flat[1]?.a11y?.hint).toBe("h");
	});
});

type Files = Map<string, string>;

function harness(files: Files, options: { answer?: boolean; alive?: boolean } = {}) {
	const fs: InjectFs = {
		mkdir: () => undefined,
		writeAtomic: (path, text) => void files.set(path, text),
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		pidAlive: () => options.alive !== false,
	};
	let clock = 1000;
	const channel = createInjectChannel({
		statePath: "/s/state.json",
		fs,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
			if (options.answer === false) return;
			const text = files.get("/s/state.json");
			if (!text) return;
			const state = JSON.parse(text) as { seq: number; a11yRead?: boolean };
			if (state.a11yRead) {
				files.set(
					injectA11yPath("/s/state.json"),
					JSON.stringify({
						req: state.seq,
						nodes: [{ cls: "UIView", ae: true, hint: "hi", id: "x", traits: "0x1", frame: [0, 0, 10, 10] }],
					})
				);
			}
			files.set("/s/state.json.ack", JSON.stringify({ seq: state.seq, pid: 5, proxy: false }));
		},
	});
	return createIosA11y({
		channel,
		fs,
		dylib: () => ({ success: true, data: "/d/libwarden-inject.dylib" }),
		requested: () => true,
		timeoutMs: 100,
	});
}

describe("createIosA11y", () => {
	test("launchEnv loads the dylib with no proxy only when an a11y read was asked for", async () => {
		const on = harness(new Map());
		const env = await on.launchEnv({});
		expect(env).toMatchObject({ success: true, data: { DYLD_INSERT_LIBRARIES: "/d/libwarden-inject.dylib" } });
		expect(env.success && env.data).not.toHaveProperty("WARDEN_NET_PROXY");
		const off = createIosA11y({
			channel: createInjectChannel({ statePath: "/s/state.json", now: () => 0, sleep: async () => undefined }),
			dylib: () => ({ success: true, data: "/d" }),
			requested: () => false,
			timeoutMs: 10,
		});
		expect(await off.launchEnv({})).toEqual({ success: true, data: undefined });
	});

	test("read asks the app, waits for the ack, and merges the dump", async () => {
		const files: Files = new Map();
		const reader = harness(files);
		await reader.launchEnv({});
		files.set("/s/state.json.ack", JSON.stringify({ seq: 0, pid: 5 }));
		const out = await reader.read(snap([el("button", { identifier: "x" })]));
		expect(out.success).toBe(true);
		if (out.success) expect(out.data.flat[0]?.a11y?.hint).toBe("hi");
	});

	test("read says why when the app was not launched with the dylib", async () => {
		const out = await harness(new Map(), { alive: false }).read(snap([]));
		expect(out).toMatchObject({ success: false, error: { code: "E_UNSUPPORTED" } });
		if (!out.success) expect(out.error.message).toContain("WARDEN_A11Y");
	});

	test("read times out when the app never answers", async () => {
		const files: Files = new Map();
		const reader = harness(files, { answer: false });
		await reader.launchEnv({});
		files.set("/s/state.json.ack", JSON.stringify({ seq: 0, pid: 5 }));
		expect(await reader.read(snap([]))).toMatchObject({ success: false, error: { code: "E_TIMEOUT" } });
	});
});
