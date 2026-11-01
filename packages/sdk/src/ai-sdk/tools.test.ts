import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeDriver } from "@delacour/warden-driver/testing/driver";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import { screenTesting } from "@delacour/warden-screen/testing/screen";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ClientSeams } from "../core";
import { createWardenTools, screenshotModelOutput, type ToolResult, type WardenTools } from "./tools";
import { CORE_TOOL_NAMES, EXTRA_TOOL_NAMES, toolInputSchemas } from "./tools.schema";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ai-sdk-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(): DeviceProvider {
	const device: InventoryDevice = {
		platform: "ios",
		id: UDID,
		name: "warden-iphone-17-1",
		state: "booted",
		wardenCreated: false,
		runtime: "iOS-26-5",
	};
	return {
		platform: "ios",
		inventory: async () => resultFactory.ok([{ ...device }]),
		create: async () => wardenErrors.err("failed", "no create in this fake"),
		boot: async () => resultFactory.ok(undefined),
		waitReady: async () => resultFactory.ok(undefined),
		shutdown: async () => resultFactory.ok(undefined),
	};
}

const ENV = {
	WARDEN_CAPACITY: "off",
	WARDEN_ARRANGE: "0",
	WARDEN_BACKGROUND: "0",
	WARDEN_SESSION_ID: "ai-sdk-test",
	HOME: "/nonexistent",
};

async function rig(
	set: "core" | "all",
	approval?: Parameters<typeof createWardenTools>[0]["approval"],
	extra: { screenshotImageMaxBytes?: number } = {}
) {
	const { driver } = screenTesting.fieldFixture({ selectAll: true });
	const provider = fakeProvider();
	const seams: ClientSeams = {
		providerFor: () => provider,
		stopHelper: async () => undefined,
		openDriver: async () => resultFactory.ok(driver as FakeDriver),
	};
	const handle = await createWardenTools({
		platform: "ios",
		app: "com.acme.app",
		set,
		...(approval ? { approval } : {}),
		...extra,
		clientOptions: { home: dir, host: { env: { ...ENV, WARDEN_HOME: dir }, cwd: dir } },
		clientSeams: seams,
	});
	return { handle, driver };
}

async function call(handle: WardenTools, name: keyof WardenTools["tools"], input: object): Promise<ToolResult> {
	const t = handle.tools[name];
	if (!t?.execute) throw new Error(`no tool ${name}`);
	const out = await t.execute(input, { toolCallId: "t1", messages: [], context: {} });
	return out as ToolResult;
}

type Step = { tool: string; input: object } | { text: string };

/** A model that plays `steps` one per generate call. */
function scripted(steps: Step[]): MockLanguageModelV4 {
	let i = 0;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			const step = steps[i] ?? { text: "done" };
			i += 1;
			const usage = {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			};
			if ("tool" in step) {
				return {
					content: [
						{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: step.tool, input: JSON.stringify(step.input) },
					],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: step.text }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			};
		},
	});
}

describe("tool set", () => {
	test("core exposes the 17 core tools; all adds the extras", async () => {
		const core = await rig("core");
		const all = await rig("all");
		try {
			expect(Object.keys(core.handle.tools).sort()).toEqual([...CORE_TOOL_NAMES].sort());
			expect(Object.keys(all.handle.tools).sort()).toEqual([...CORE_TOOL_NAMES, ...EXTRA_TOOL_NAMES].sort());
		} finally {
			await core.handle.close();
			await all.handle.close();
		}
	});

	test("every schema is an object schema", () => {
		for (const schema of Object.values(toolInputSchemas)) expect(schema.safeParse({}).success).toBeDefined();
		expect(toolInputSchemas.press.safeParse({ ref: "nope" }).success).toBe(false);
		expect(toolInputSchemas.press.safeParse({ ref: "@e3" }).success).toBe(true);
	});
});

describe("mock model drives the device", () => {
	test("open → snapshot → press(@eN) → fill over FakeDriver", async () => {
		const { handle, driver } = await rig("core");
		try {
			const model = scripted([
				{ tool: "open", input: {} },
				{ tool: "snapshot", input: { interactiveOnly: true } },
				{ tool: "press", input: { ref: "@e1" } },
				{ tool: "fill", input: { ref: "@e1", text: "grace" } },
				{ text: "filled" },
			]);
			expect(handle.session).toBeUndefined();
			const result = await generateText({
				model,
				prompt: "type grace in the email field",
				tools: handle.tools,
				stopWhen: isStepCount(8),
			});
			expect(result.text).toBe("filled");
			const outputs = result.steps.flatMap((s) =>
				s.content.flatMap((p) => (p.type === "tool-result" ? [p.output as ToolResult] : []))
			);
			expect(outputs).toHaveLength(4);
			expect(outputs.filter((o) => !o.ok)).toEqual([]);
			const snap = outputs[1];
			expect(snap?.ok && typeof snap.screen === "string" ? snap.screen : "").toContain("@e1");
			expect(driver.callsOf("tap").length).toBeGreaterThanOrEqual(1);
			expect(handle.session).toBeDefined();
		} finally {
			await handle.close();
		}
	});

	test("snapshot output is compact text carrying @eN refs", async () => {
		const { handle } = await rig("core");
		try {
			const out = await call(handle, "snapshot", {});
			expect(out.ok).toBe(true);
			if (out.ok) {
				expect(out.screen).toMatch(/@e1/);
				expect(String(out.screen).length).toBeLessThan(2000);
			}
		} finally {
			await handle.close();
		}
	});
});

describe("errors are results, not throws", () => {
	test("a missing target is a usage failure with a hint", async () => {
		const { handle } = await rig("core");
		try {
			const out = await call(handle, "press", {});
			expect(out).toMatchObject({ ok: false, error: { code: "usage" } });
		} finally {
			await handle.close();
		}
	});

	test("an unknown ref returns a recoverable error that says to re-snapshot", async () => {
		const { handle } = await rig("core");
		try {
			const out = await call(handle, "press", { ref: "@e42" });
			expect(out.ok).toBe(false);
			if (!out.ok) {
				expect(["stale_ref", "target_not_found"]).toContain(out.error.code);
				expect(out.error.hint?.toLowerCase()).toContain("snapshot");
			}
		} finally {
			await handle.close();
		}
	});
});

describe("approval", () => {
	test("approval map reaches toolApproval and the tool does not run until approved", async () => {
		const { handle, driver } = await rig("core", { press: "user-approval", eval: "user-approval" });
		try {
			expect(handle.toolApproval).toEqual({ press: "user-approval" });
			await call(handle, "snapshot", {});
			const before = driver.callsOf("tap").length;
			const result = await generateText({
				model: scripted([{ tool: "press", input: { ref: "@e1" } }, { text: "waiting" }]),
				prompt: "tap it",
				tools: handle.tools,
				toolApproval: handle.toolApproval,
				stopWhen: isStepCount(4),
			});
			const kinds = result.content.map((p) => p.type);
			expect(kinds).toContain("tool-approval-request");
			expect(driver.callsOf("tap").length).toBe(before);
		} finally {
			await handle.close();
		}
	});
});

describe("record tools", () => {
	test("record_start, fill, record_status and record_stop write the spec", async () => {
		const { handle } = await rig("all");
		try {
			expect(await call(handle, "record_status", {})).toEqual({ ok: true, recording: false });
			const started = await call(handle, "record_start", { name: "fill field" });
			expect(started).toMatchObject({ ok: true, kind: "spec", target: join(dir, "e2e", "fill-field.e2e.ts") });
			await call(handle, "fill", { selector: "id=field", text: "hello" });
			await call(handle, "record_note", { text: "filled" });
			expect(await call(handle, "record_status", {})).toMatchObject({ ok: true, recording: true, steps: 2 });
			const stopped = await call(handle, "record_stop", { verify: false });
			expect(stopped).toMatchObject({ ok: true, verified: false, steps: 2 });
			expect(readFileSync(join(dir, "e2e", "fill-field.e2e.ts"), "utf8")).toContain("field");
		} finally {
			await handle.close();
		}
	});

	test("record_stop without a recording is a recoverable failure", async () => {
		const { handle } = await rig("all");
		try {
			const out = await call(handle, "record_stop", {});
			expect(out).toMatchObject({ ok: false, error: { code: "no_recording" } });
		} finally {
			await handle.close();
		}
	});
});

describe("perf tools", () => {
	test("the perf_* tools are read-only extras with bounded inputs", () => {
		expect(EXTRA_TOOL_NAMES).toEqual(
			expect.arrayContaining(["perf_startup", "perf_metrics", "perf_memory", "perf_logs", "perf_crashes"])
		);
		expect(toolInputSchemas.perf_startup.safeParse({ runs: 5, warm: true }).success).toBe(true);
		expect(toolInputSchemas.perf_startup.safeParse({ runs: 99 }).success).toBe(false);
		expect(toolInputSchemas.perf_logs.safeParse({ level: "loud" }).success).toBe(false);
		expect(toolInputSchemas.perf_logs.safeParse({ level: "error", lines: 50, grep: "Warning" }).success).toBe(true);
	});

	test("a perf tool failure is returned to the model, not thrown", async () => {
		const { handle } = await rig("all");
		try {
			const out = await call(handle, "perf_logs", { app: "com.acme.shop", lines: 5 });
			expect(typeof out.ok).toBe("boolean");
		} finally {
			await handle.close();
		}
	});
});

/** A 3x5 stub PNG header on disk: the fake driver writes nothing, the client reads the file back. */
function stubPng(name: string): string {
	const path = join(dir, name);
	writeFileSync(
		path,
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 5])
	);
	return path;
}

describe("screenshot as an image content part", () => {
	test("the result carries the PNG and toModelOutput turns it into an image part", async () => {
		const { handle } = await rig("core");
		try {
			const out = await call(handle, "screenshot", { path: stubPng("s.png") });
			expect(out.ok).toBe(true);
			if (!out.ok) return;
			expect(out.path).toBe(join(dir, "s.png"));
			expect(out.width).toBe(3);
			const image = out.image as { mediaType: string; data: string };
			expect(image.mediaType).toBe("image/png");
			expect(image.data.length).toBeGreaterThan(8);
			const model = screenshotModelOutput(out);
			expect(model.type).toBe("content");
			if (model.type !== "content") return;
			expect(model.value).toHaveLength(2);
			expect(model.value[0]).toMatchObject({ type: "text" });
			expect(JSON.stringify(model.value[0])).not.toContain(image.data);
			expect(model.value[1]).toMatchObject({
				type: "file",
				mediaType: "image/png",
				data: { type: "data", data: image.data },
			});
		} finally {
			await handle.close();
		}
	});

	test("a PNG over the cap is not sent: path only, with the reason", async () => {
		const { handle } = await rig("core", undefined, { screenshotImageMaxBytes: 4 });
		try {
			const out = await call(handle, "screenshot", { path: stubPng("big.png") });
			expect(out.ok).toBe(true);
			if (!out.ok) return;
			expect(out.image).toBeUndefined();
			expect(String(out.imageOmitted)).toContain("over the 4 byte cap");
			const model = screenshotModelOutput(out);
			expect(model.type === "content" && model.value).toHaveLength(1);
		} finally {
			await handle.close();
		}
	});

	test("a failed screenshot stays a json failure for the model", () => {
		const failure: ToolResult = { ok: false, error: { code: "failed", message: "boom" } };
		expect(screenshotModelOutput(failure)).toEqual({ type: "json", value: failure });
	});

	test("the mock model receives the image part in the next step's prompt", async () => {
		const { handle } = await rig("core");
		try {
			const prompts: unknown[] = [];
			const inner = scripted([{ tool: "screenshot", input: { path: stubPng("m.png") } }, { text: "seen" }]);
			const model = new MockLanguageModelV4({
				doGenerate: async (options) => {
					prompts.push(options.prompt);
					return inner.doGenerate(options);
				},
			});
			const result = await generateText({ model, prompt: "look", tools: handle.tools, stopWhen: isStepCount(4) });
			expect(result.text).toBe("seen");
			expect(prompts).toHaveLength(2);
			const toolMessage = JSON.stringify(prompts[1]);
			expect(toolMessage).toContain("image/png");
		} finally {
			await handle.close();
		}
	});
});
