import { describe, expect, test } from "bun:test";
import { demoPaths } from "./paths";

describe("demoPaths", () => {
	const p = demoPaths("/repo", "biometrics/faceid", "/tmp");
	test("definition under the feature folder", () => {
		expect(p.definition).toBe("/repo/apps/example/demos/biometrics/faceid.demo.ts");
	});
	test("assets grouped under the feature folder", () => {
		expect(p.mp4).toBe("/repo/apps/docs/public/demos/biometrics/faceid.mp4");
		expect(p.jpg).toBe("/repo/apps/docs/public/demos/biometrics/faceid.jpg");
		expect(p.publicDir).toBe("/repo/apps/docs/public/demos/biometrics");
	});
	test("work dir and claim label per demo", () => {
		expect(p.work).toBe("/tmp/warden-demo/biometrics/faceid");
		expect(p.label).toBe("demo-biometrics-faceid");
	});
	test("rejects a name without a feature folder or with unsafe segments", () => {
		for (const bad of ["faceid", "biometrics/", "/faceid", "a/b/c", "Bio/Face", "../x/y", "a b/c"]) {
			expect(() => demoPaths("/repo", bad, "/tmp")).toThrow(/<feature>\/<clip>/);
		}
	});
});
