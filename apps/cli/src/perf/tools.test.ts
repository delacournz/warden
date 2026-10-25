import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { TraceProcessorPin } from "@delacour/warden-perf/android/trace-processor.data";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { perfToolsInstall } from "./tools";
import { type TraceProcessorDeps, traceProcessorPath } from "./trace-processor";

const PAYLOAD = new TextEncoder().encode("fake-binary".repeat(100));
const PIN: TraceProcessorPin = {
	artifact: "linux-amd64",
	sha256: createHash("sha256").update(PAYLOAD).digest("hex"),
	bytes: PAYLOAD.byteLength,
};

function deps(urls: string[]): TraceProcessorDeps {
	return {
		fetch: async (url) => {
			urls.push(url);
			return new Response(PAYLOAD, { headers: { "content-length": String(PAYLOAD.byteLength) } });
		},
		platform: "linux",
		arch: "x64",
		writeErr: () => {},
		now: () => 1,
		pinFor: () => ({ target: "linux-x64", pin: PIN }),
	};
}

let c: TestContext;
afterEach(() => c?.cleanup());

describe("perf tools install", () => {
	test("--yes installs; --json is a single clean document", async () => {
		c = testContext(["perf"]);
		const urls: string[] = [];
		const code = await perfToolsInstall(c, deps(urls), "trace-processor", { yes: true, json: true });
		expect(code).toBe(0);
		expect(existsSync(traceProcessorPath(c))).toBe(true);
		expect(c.stdout).toHaveLength(1);
		const doc = JSON.parse(c.stdout[0] ?? "");
		expect(doc).toMatchObject({
			ok: true,
			command: "tools install",
			result: { tool: "trace-processor", downloaded: true },
		});
	});

	test("second run reports already installed without fetching", async () => {
		c = testContext(["perf"]);
		const urls: string[] = [];
		await perfToolsInstall(c, deps(urls), "trace-processor", { yes: true });
		urls.length = 0;
		c.stdout.length = 0;
		expect(await perfToolsInstall(c, deps(urls), "trace-processor", {})).toBe(0);
		expect(urls).toEqual([]);
		expect(c.stdout[0]).toContain("already installed");
	});

	test("non-interactive without --yes exits 3 with the install hint", async () => {
		c = testContext(["perf"]);
		const urls: string[] = [];
		expect(await perfToolsInstall(c, deps(urls), "trace-processor", { json: true })).toBe(3);
		expect(JSON.parse(c.stdout[0] ?? "")).toMatchObject({
			ok: false,
			error: { code: "tool_missing", hint: "warden perf tools install trace-processor --yes" },
		});
		expect(urls).toEqual([]);
	});

	test("interactive decline exits 3", async () => {
		c = testContext(["perf"], { ui: scriptedUi({ interactive: true, confirm: [false] }) });
		expect(await perfToolsInstall(c, deps([]), "trace-processor", {})).toBe(3);
	});

	test("unknown tool is a usage error", async () => {
		c = testContext(["perf"]);
		expect(await perfToolsInstall(c, deps([]), "frida", { json: true })).toBe(1);
	});
});
