import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Suite } from "@delacour/warden-core/affected/affected";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { specBundleId, specLaunchArgs } from "./launch";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("specBundleId", () => {
	function setup(device: boolean): { suite: Suite; ctx: TestContext } {
		const c = testContext([]);
		ctx = c;
		c.env = { ...c.env, ...OWNER_ENV };
		mkdirSync(join(c.cwd, "app"), { recursive: true });
		writeFileSync(
			join(c.cwd, "warden.config.json"),
			JSON.stringify({
				projects: [
					{
						name: "demo",
						root: "app",
						bundleId: { ios: "com.demo", android: "com.demo" },
						...(device ? { ios: { device: { bundleIdentifier: "com.me.demo" } } } : {}),
					},
				],
			})
		);
		const suite = {
			name: "s",
			cwd: c.cwd,
			projectRoot: join(c.cwd, "app"),
			config: { spec: { bundleId: "com.spec" } },
		};
		return { suite: suite as unknown as Suite, ctx: c };
	}

	test("spec.bundleId wins for simulators; an iPhone takes the project's device bundle id over it", async () => {
		const { suite, ctx: c } = setup(true);
		expect(await specBundleId(c, suite, "ios")).toEqual({ success: true, data: "com.spec" });
		expect(await specBundleId(c, suite, "ios", true)).toEqual({ success: true, data: "com.me.demo" });
	});

	test("the override is iOS-only and optional", async () => {
		const { suite, ctx: c } = setup(true);
		expect(await specBundleId(c, suite, "android", true)).toEqual({ success: true, data: "com.spec" });
		const plain = setup(false);
		expect(await specBundleId(plain.ctx, plain.suite, "ios", true)).toEqual({ success: true, data: "com.spec" });
	});
});

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
