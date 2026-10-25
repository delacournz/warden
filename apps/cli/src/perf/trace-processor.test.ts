import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TraceProcessorPin, traceProcessorFileName } from "@delacour/warden-perf/android/trace-processor.data";
import { type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
import {
	downloadTraceProcessor,
	resolveTraceProcessor,
	type TraceProcessorDeps,
	traceProcessorPath,
} from "./trace-processor";

const PAYLOAD = new TextEncoder().encode("#!fake trace_processor_shell\n".repeat(50));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PIN: TraceProcessorPin = { artifact: "mac-arm64", sha256: sha(PAYLOAD), bytes: PAYLOAD.byteLength };

function streamOf(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
	const half = Math.floor(bytes.byteLength / 2);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.slice(0, half));
			controller.enqueue(bytes.slice(half));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-length": String(bytes.byteLength), ...headers } });
}

type Fake = { deps: TraceProcessorDeps; urls: string[]; err: string[] };

function fake(over: Partial<TraceProcessorDeps> = {}, payload: Uint8Array = PAYLOAD): Fake {
	const urls: string[] = [];
	const err: string[] = [];
	let t = 0;
	return {
		urls,
		err,
		deps: {
			fetch: async (url) => {
				urls.push(url);
				return streamOf(payload);
			},
			platform: "darwin",
			arch: "arm64",
			writeErr: (s) => err.push(s),
			now: () => (t += 200),
			pinFor: () => ({ target: "darwin-arm64", pin: PIN }),
			...over,
		},
	};
}

let c: TestContext;
let ui: ScriptedUi;
afterEach(() => c?.cleanup());

function setup(
	env: Record<string, string> = {},
	interactive = false,
	opts: { rich?: boolean; confirm?: Array<boolean | undefined> } = {}
): TestContext {
	ui = scriptedUi({ interactive, rich: opts.rich ?? false, confirm: opts.confirm ?? [] });
	c = testContext(["perf"], { ui });
	c.env = { ...c.env, ...env };
	return c;
}

describe("downloadTraceProcessor", () => {
	test("streams, verifies sha256, chmod 755, renames into tools/", async () => {
		setup();
		const f = fake();
		const res = await downloadTraceProcessor(c, f.deps);
		expect(res.success).toBe(true);
		const path = traceProcessorPath(c);
		expect(path.endsWith(traceProcessorFileName())).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o755);
		expect(statSync(path).size).toBe(PAYLOAD.byteLength);
		expect(readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		expect(f.urls[0]).toContain("/perfetto-luci-artifacts/");
		expect(f.urls[0]).toEndWith("/mac-arm64/trace_processor_shell");
	});

	test("non-rich stderr: exactly one start and one done line, nothing on stdout", async () => {
		setup();
		const f = fake();
		await downloadTraceProcessor(c, f.deps);
		expect(f.err).toHaveLength(2);
		expect(f.err[0]).toStartWith("downloading trace_processor");
		expect(f.err[1]).toStartWith("downloaded trace_processor");
		expect(c.stdout).toEqual([]);
	});

	test("rich stderr: redraws the bar with percent and speed", async () => {
		setup({}, false, { rich: true });
		const f = fake();
		await downloadTraceProcessor(c, f.deps);
		const bars = f.err.filter((s) => s.startsWith("\r"));
		expect(bars.length).toBeGreaterThan(1);
		expect(bars.at(-1)).toContain("100%");
		expect(bars.at(-1)).toContain("MB/s");
		expect(c.stdout).toEqual([]);
	});

	test("checksum mismatch installs nothing", async () => {
		setup();
		const f = fake({}, new TextEncoder().encode("tampered"));
		const res = await downloadTraceProcessor(c, f.deps);
		expect(res).toMatchObject({ success: false, error: { code: "tool_missing" } });
		expect(existsSync(traceProcessorPath(c))).toBe(false);
		const dir = dirname(traceProcessorPath(c));
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	test("HTTP failure and unsupported hosts are tool_missing", async () => {
		setup();
		const bad = fake({ fetch: async () => new Response("no", { status: 404 }) });
		expect(await downloadTraceProcessor(c, bad.deps)).toMatchObject({
			success: false,
			error: { code: "tool_missing" },
		});
		const none = fake({ pinFor: () => undefined });
		expect(await downloadTraceProcessor(c, none.deps)).toMatchObject({
			success: false,
			error: { code: "tool_missing" },
		});
	});
});

describe("resolveTraceProcessor", () => {
	test("cached binary: no prompt, no fetch", async () => {
		setup({}, true);
		const path = traceProcessorPath(c);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "x");
		const f = fake();
		expect(await resolveTraceProcessor(c, f.deps, { yes: false })).toEqual({ success: true, data: path });
		expect(f.urls).toEqual([]);
		expect(ui.events).toEqual([]);
	});

	test("WARDEN_TRACE_PROCESSOR wins; a missing override never downloads", async () => {
		setup({ WARDEN_TRACE_PROCESSOR: "/nope/tp" });
		const f = fake();
		const res = await resolveTraceProcessor(c, f.deps, { yes: true });
		expect(res).toMatchObject({ success: false, error: { code: "tool_missing" } });
		expect(f.urls).toEqual([]);
	});

	test("non-interactive without --yes: tool_missing with the install hint, no download", async () => {
		setup();
		const f = fake();
		const res = await resolveTraceProcessor(c, f.deps, { yes: false });
		expect(res).toMatchObject({
			success: false,
			error: { code: "tool_missing", hint: "warden perf tools install trace-processor --yes" },
		});
		expect(f.urls).toEqual([]);
	});

	test("--yes downloads without asking", async () => {
		setup();
		const f = fake();
		const res = await resolveTraceProcessor(c, f.deps, { yes: true });
		expect(res.success).toBe(true);
		expect(ui.events).toEqual([]);
	});

	test("interactive: asks, downloads on yes", async () => {
		setup({}, true, { confirm: [true] });
		const f = fake();
		const res = await resolveTraceProcessor(c, f.deps, { yes: false });
		expect(res.success).toBe(true);
		expect(ui.events[0]).toContain("Download trace_processor v");
		expect(ui.events[0]).toContain("MB");
	});

	test("interactive: declined or cancelled is tool_missing and nothing is fetched", async () => {
		for (const answer of [false, undefined]) {
			setup({}, true, { confirm: [answer] });
			const f = fake();
			const res = await resolveTraceProcessor(c, f.deps, { yes: false });
			expect(res).toMatchObject({ success: false, error: { code: "tool_missing" } });
			expect(f.urls).toEqual([]);
			c.cleanup();
		}
	});
});
