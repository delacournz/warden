import { describe, expect, test } from "bun:test";
import { npmPlatforms, RELEASE_TARGETS } from "./platforms";

describe("releaseTarget", () => {
	test("maps every supported node platform/arch to a target", () => {
		expect(npmPlatforms.releaseTarget("darwin", "arm64")).toEqual({ success: true, data: "darwin-arm64" });
		expect(npmPlatforms.releaseTarget("linux", "x64")).toEqual({ success: true, data: "linux-x64" });
		for (const target of RELEASE_TARGETS) {
			const [os = "", cpu = ""] = target.split("-");
			expect(npmPlatforms.releaseTarget(os, cpu)).toEqual({ success: true, data: target });
		}
	});

	test("unsupported platform → error naming the supported ones", () => {
		const result = npmPlatforms.releaseTarget("win32", "x64");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("win32-x64");
			expect(result.error).toContain("darwin-arm64");
		}
	});
});

test("platformPackageName", () => {
	expect(npmPlatforms.platformPackageName("linux-arm64")).toBe("@delacour/warden-linux-arm64");
});
