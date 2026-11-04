import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_PNG, seedCameraPlaceholders } from "./camera-placeholder";
import { sniffCameraMedia } from "./conditions/camera-media";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("seedCameraPlaceholders", () => {
	test("writes a png both emulator cameras can read, creating the dir", () => {
		const root = mkdtempSync(join(tmpdir(), "cam-ph-"));
		dirs.push(root);
		const dir = join(root, "camera", "emulator-5554");
		seedCameraPlaceholders(dir);
		for (const name of ["back.png", "front.png"]) {
			const sniffed = sniffCameraMedia(join(dir, name));
			expect(sniffed.success && sniffed.data).toEqual({ kind: "image", ext: "png" });
		}
	});

	test("never overwrites an existing feed", () => {
		const root = mkdtempSync(join(tmpdir(), "cam-ph-"));
		dirs.push(root);
		writeFileSync(join(root, "back.png"), "mine");
		seedCameraPlaceholders(root);
		expect(readFileSync(join(root, "back.png"), "utf8")).toBe("mine");
		expect(existsSync(join(root, "front.png"))).toBe(true);
		expect(PLACEHOLDER_PNG.length).toBeGreaterThan(8);
	});
});
