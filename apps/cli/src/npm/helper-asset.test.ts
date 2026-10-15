import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { fakeHelperDist } from "./helper.testing";
import { packHelper } from "./helper-asset";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "warden-helper-asset-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("packHelper", () => {
	test("tars the dist dir at its root and writes SHA256SUMS for it", async () => {
		const dist = join(root, "dist");
		const out = join(root, "out");
		fakeHelperDist(dist);
		const packed = await packHelper({ distDir: dist, outDir: out, exec: bunExec });
		if (!packed.success) throw new Error(packed.error);
		const bytes = readFileSync(join(out, "warden-simd-darwin-arm64.tgz"));
		const sha = createHash("sha256").update(bytes).digest("hex");
		expect(packed.data.sha256).toBe(sha);
		expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toBe(`${sha}  warden-simd-darwin-arm64.tgz\n`);

		const extracted = join(root, "extracted");
		mkdirSync(extracted);
		expect((await bunExec(["tar", "-xzf", packed.data.tgz, "-C", extracted])).exitCode).toBe(0);
		for (const path of ["warden-simd", "Resources/SimulatorFrameworkBridge-iOS", "manifest.json"]) {
			expect(existsSync(join(extracted, path))).toBe(true);
		}
	});

	test("incomplete dist → error, nothing written", async () => {
		const dist = join(root, "dist");
		fakeHelperDist(dist, { guest: false });
		const packed = await packHelper({ distDir: dist, outDir: join(root, "out"), exec: bunExec });
		expect(packed.success).toBe(false);
		expect(existsSync(join(root, "out"))).toBe(false);
	});

	test("tar failing is reported", async () => {
		const dist = join(root, "dist");
		fakeHelperDist(dist);
		const packed = await packHelper({
			distDir: dist,
			outDir: join(root, "out"),
			exec: async () => ({ exitCode: 2, stdout: "", stderr: "tar: boom" }),
		});
		expect(packed.success).toBe(false);
		if (!packed.success) expect(packed.error).toContain("tar: boom");
	});
});
