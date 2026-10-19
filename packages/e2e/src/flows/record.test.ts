import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, snapshotOf } from "../driver/driver.testing";
import type { Flow } from "./flow.schema";
import { flowSchema } from "./flow.schema";
import {
	appendStep,
	coordsTarget,
	createFlowFile,
	createFlowRecorder,
	readFlowFile,
	redactSecrets,
	resolveText,
	secretsFromEnv,
	targetFromElement,
} from "./record";

const header: Pick<Flow, "name" | "createdAt" | "recordedOn"> = {
	name: "sign in",
	createdAt: 1,
	recordedOn: { platform: "ios", device: "iPhone 16", screen: { width: 390, height: 844, scale: 3 } },
};

describe("targetFromElement", () => {
	const snapshot = snapshotOf([
		el("button", { id: "sign-in-submit", label: "Sign in", frame: { x: 24, y: 300, width: 342, height: 48 } }),
		el("button", { label: "Sign in with Apple", frame: { x: 24, y: 360, width: 342, height: 48 } }),
		el("button", { id: "row", label: "Row" }),
		el("button", { id: "row", label: "Row" }),
		el("button", { text: "Save" }),
		el("other"),
		el("other"),
	]);
	const at = (id: string) => {
		const element = snapshot.flat.find((candidate) => candidate.id === id);
		if (!element) throw new Error(`no element ${id}`);
		return element;
	};

	test("builds the chain id → role+label → path and a landmark", () => {
		const target = targetFromElement(at("0"), snapshot);
		expect(target).toEqual({
			kind: "selector",
			selector: "id=sign-in-submit",
			chain: [
				{ by: "id", selector: "id=sign-in-submit" },
				// "Sign in" is also a substring of "Sign in with Apple": pinned with nth
				{ by: "role-label", selector: 'label="Sign in" role=button nth=0' },
				{ by: "path", path: "0", role: "button" },
			],
			landmark: { role: "button", frame: { x: 24, y: 300, width: 342, height: 48 }, label: "Sign in" },
		});
	});

	test("pins repeated ids with nth in document order", () => {
		const second = targetFromElement(at("3"), snapshot);
		expect(second.kind === "selector" && second.selector).toBe("id=row nth=1");
	});

	test("an Android-style element with only text goes role+text", () => {
		const target = targetFromElement(at("4"), snapshot);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.chain.map((entry) => entry.by)).toEqual(["role-text", "path"]);
		expect(target.selector).toBe("text=Save role=button");
	});

	test("an element with nothing to say falls back to role + nth and the path", () => {
		const target = targetFromElement(at("6"), snapshot);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.selector).toBe("role=other nth=1");
		expect(target.chain).toEqual([{ by: "path", path: "6", role: "other" }]);
	});

	test("lists role+text after role+label only when text differs from the label", () => {
		const both = snapshotOf([el("button", { id: "go", label: "Go", text: "GO NOW" })]);
		const target = targetFromElement(both.flat[0] ?? at("0"), both);
		if (target.kind !== "selector") throw new Error("expected a selector target");
		expect(target.chain.map((entry) => entry.by)).toEqual(["id", "role-label", "role-text", "path"]);
	});

	test("never stores an @ref", () => {
		const target = targetFromElement(at("0"), snapshot);
		expect(JSON.stringify(target)).not.toMatch(/@e\d/);
	});

	test("an element that is not in the snapshot becomes a coordinate target with a warning", () => {
		const stranger = { ...at("0"), id: "9.9" };
		const target = targetFromElement(stranger, snapshot);
		expect(target.kind).toBe("coords");
		if (target.kind === "coords") {
			expect(target.x).toBe(195);
			expect(target.y).toBe(324);
			expect(target.warning).toContain("not in the snapshot");
		}
	});

	test("coordsTarget carries the default warning", () => {
		expect(coordsTarget({ x: 1, y: 2 }).warning).toContain("coordinates");
	});
});

describe("redaction", () => {
	const env = { WARDEN_UI_SECRET_PASSWORD: "hunter2", WARDEN_UI_SECRET_EMPTY: "", HOME: "/Users/x" };

	test("reads only non-empty WARDEN_UI_SECRET_* values", () => {
		expect(secretsFromEnv(env)).toEqual([{ name: "PASSWORD", value: "hunter2" }]);
	});

	test("a text equal to a secret value is stored as its name", () => {
		expect(redactSecrets("hunter2", env)).toEqual({ secret: "PASSWORD" });
	});

	test("other text, and text that merely contains a secret, stays literal", () => {
		expect(redactSecrets("hello", env)).toBe("hello");
	});

	test("resolveText returns literals and looks secrets up in env", () => {
		expect(resolveText("hello", env)).toEqual({ success: true, data: "hello" });
		expect(resolveText({ secret: "PASSWORD" }, env)).toEqual({ success: true, data: "hunter2" });
		const missing = resolveText({ secret: "TOKEN" }, env);
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain("WARDEN_UI_SECRET_TOKEN");
	});
});

describe("appendStep", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "flow-record-"));
		file = join(dir, "sign-in.flow.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("createFlowFile writes an empty valid flow; readFlowFile parses it", () => {
		const created = createFlowFile(file, header);
		expect(created.success).toBe(true);
		const read = readFlowFile(file);
		expect(read.success && read.data.steps).toEqual([]);
		expect(flowSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).success).toBe(true);
	});

	test("createFlowFile refuses to overwrite", () => {
		createFlowFile(file, header);
		const again = createFlowFile(file, header);
		expect(again.success).toBe(false);
	});

	test("appends in order and numbers steps itself", async () => {
		createFlowFile(file, header);
		const first = await appendStep(file, { kind: "home", at: 10 });
		const second = await appendStep(file, { kind: "back", at: 20, note: "go back" });
		expect(first.success && first.data.i).toBe(0);
		expect(second.success && second.data.i).toBe(1);
		const read = readFlowFile(file);
		expect(read.success && read.data.steps.map((step) => step.kind)).toEqual(["home", "back"]);
	});

	test("a missing file is flow_missing and an invalid one flow_invalid", async () => {
		const missing = await appendStep(join(dir, "nope.flow.json"), { kind: "home", at: 1 });
		expect(!missing.success && missing.error.code).toBe("flow_missing");
		writeFileSync(file, '{"v":3}');
		const invalid = await appendStep(file, { kind: "home", at: 1 });
		expect(!invalid.success && invalid.error.code).toBe("flow_invalid");
	});

	test("rewrites go through the injected write, whole-file", async () => {
		createFlowFile(file, header);
		const writes: { path: string; text: string }[] = [];
		await appendStep(file, { kind: "home", at: 1 }, { write: (path, text) => void writes.push({ path, text }) });
		expect(writes).toHaveLength(1);
		expect(writes[0]?.path).toBe(file);
		expect(flowSchema.safeParse(JSON.parse(writes[0]?.text ?? "")).success).toBe(true);
	});

	test("leaves no lock or temp file behind", async () => {
		createFlowFile(file, header);
		await appendStep(file, { kind: "home", at: 1 });
		expect(readdirSync(dir)).toEqual(["sign-in.flow.json"]);
	});

	test("a stale lock is broken", async () => {
		createFlowFile(file, header);
		writeFileSync(`${file}.lock`, "999999");
		const result = await appendStep(file, { kind: "home", at: 1 }, { staleMs: 0 });
		expect(result.success).toBe(true);
	});

	test("a held lock times out as lock_timeout", async () => {
		createFlowFile(file, header);
		writeFileSync(`${file}.lock`, "1");
		const result = await appendStep(file, { kind: "home", at: 1 }, { timeoutMs: 40, staleMs: 60_000 });
		expect(!result.success && result.error.code).toBe("lock_timeout");
	});

	test("concurrent appenders in one process never lose or reorder a step", async () => {
		createFlowFile(file, header);
		const total = 25;
		const run = async (tag: string) => {
			const results = [];
			for (let n = 0; n < total; n += 1)
				results.push(await appendStep(file, { kind: "screen", type: "screenshot", at: n, name: `${tag}-${n}` }));
			return results;
		};
		const [a, b] = await Promise.all([run("a"), run("b")]);
		expect([...a, ...b].every((result) => result.success)).toBe(true);
		const read = readFlowFile(file);
		if (!read.success) throw new Error(read.error.message);
		expect(read.data.steps).toHaveLength(total * 2);
		expect(read.data.steps.map((step) => step.i)).toEqual(Array.from({ length: total * 2 }, (_, i) => i));
		for (const tag of ["a", "b"]) {
			const sequence = read.data.steps.flatMap((step) =>
				step.kind === "screen" && step.type === "screenshot" && step.name?.startsWith(`${tag}-`)
					? [Number(step.name.slice(2))]
					: []
			);
			expect(sequence).toEqual(Array.from({ length: total }, (_, n) => n));
		}
	});

	test("concurrent appenders in separate processes keep a contiguous order", async () => {
		createFlowFile(file, header);
		const worker = join(import.meta.dir, "record.worker.testing.ts");
		const total = 15;
		const spawn = (tag: string) =>
			Bun.spawn(["bun", worker, file, tag, String(total)], { stdout: "pipe", stderr: "pipe" });
		const [one, two] = [spawn("p"), spawn("q")];
		const codes = await Promise.all([one.exited, two.exited]);
		expect(codes).toEqual([0, 0]);
		const read = readFlowFile(file);
		if (!read.success) throw new Error(read.error.message);
		expect(read.data.steps).toHaveLength(total * 2);
		expect(read.data.steps.map((step) => step.i)).toEqual(Array.from({ length: total * 2 }, (_, i) => i));
		expect(readdirSync(dir)).toEqual(["sign-in.flow.json"]);
	});

	test("createFlowRecorder is the append seam: append(step) → numbered step", async () => {
		createFlowFile(file, header);
		const recorder = createFlowRecorder(file);
		const result = await recorder.append({ kind: "home", at: 5 });
		expect(result.success && result.data).toEqual({ kind: "home", at: 5, i: 0 });
	});
});
