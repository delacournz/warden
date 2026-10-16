import { describe, expect, test } from "bun:test";
import { specLaunchArgs } from "./launch";

describe("specLaunchArgs", () => {
	test("Metro suites: --initialUrl, then metro.launchArgs, then spec.launchArgs", () => {
		expect(
			specLaunchArgs({ metroLaunchArgs: ["-E2E", "YES"], launchArgs: ["--seed", "7"] }, "http://127.0.0.1:8081")
		).toEqual(["--initialUrl", "http://127.0.0.1:8081", "-E2E", "YES", "--seed", "7"]);
	});

	test("without Metro only spec.launchArgs", () => {
		expect(specLaunchArgs({ metroLaunchArgs: [], launchArgs: ["--seed", "7"] }, undefined)).toEqual(["--seed", "7"]);
		expect(specLaunchArgs({ metroLaunchArgs: [], launchArgs: [] }, undefined)).toEqual([]);
	});
});
