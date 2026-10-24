import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { parseRuntime } from "../e2e/e2e-runtime";

const SCRIPT = resolve(import.meta.dir, "../../scripts/e2e-runtime.ts");
const REPO = resolve(import.meta.dir, "../../../..");

describe("scripts/e2e-runtime.ts (the real packages/e2e)", () => {
	let out: string;
	beforeEach(() => {
		out = mkdtempSync(join(tmpdir(), "warden-e2e-runtime-pack-"));
	});
	afterEach(() => rmSync(out, { recursive: true, force: true }));

	/** In a child process: `Bun.build` inside `bun test` mis-resolves files the test process already loaded. */
	test("writes a blob with index/preload, zod inlined (only bun:test left external) and the version baked in", async () => {
		const blob = join(out, "e2e-runtime.bin");
		const result = await bunExec(["bun", SCRIPT, REPO, blob, "9.8.7"]);
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
		const parsed = parseRuntime(readFileSync(blob, "utf8"));
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const files = parsed.data;
		expect(Object.keys(files)).toContain("index.mjs");
		expect(Object.keys(files)).toContain("preload.mjs");
		const all = Object.values(files).join("\n");
		expect(all).not.toMatch(/from\s*"zod"/);
		expect(all).toContain("bun:test");
		expect(all).toContain('"9.8.7"');
	}, 60_000);
});
