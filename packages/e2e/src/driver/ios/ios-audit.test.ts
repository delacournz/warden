import { describe, expect, test } from "bun:test";
import { checkoutRunnerSources, createIosNativeAudit } from "./ios-audit";

const noExec = async () => ({ exitCode: 127, stdout: "", stderr: "" });

describe("createIosNativeAudit", () => {
	test("skips with the reason when the runner cannot be built", async () => {
		const audit = createIosNativeAudit({
			udid: "U-1",
			exec: noExec,
			bundleId: () => "com.example",
			ensureBuild: async () => ({ success: false, error: "the iOS runner sources are not bundled with this install" }),
		});
		const out = await audit.audit({});
		expect(out.issues).toEqual([]);
		expect(out.skipped?.source).toBe("xcuitest");
		expect(out.skipped?.reason).toContain("not bundled");
		await audit.close();
	});

	test("skips when no app is known to audit", async () => {
		const audit = createIosNativeAudit({ udid: "U-1", exec: noExec, bundleId: () => undefined });
		const out = await audit.audit({});
		expect(out.skipped?.reason).toContain("bundle id");
	});
});

describe("checkoutRunnerSources", () => {
	test("reads the runner project from this checkout", async () => {
		const files = await checkoutRunnerSources();
		expect(files.success).toBe(true);
		if (files.success) expect(Object.keys(files.data)).toContain("ios-runner/WardenRunner.xcodeproj/project.pbxproj");
	});

	test("is an error, not a throw, where the sources are not bundled", async () => {
		const files = await checkoutRunnerSources("/nonexistent/dir/driver/ios");
		expect(files.success).toBe(false);
	});
});
