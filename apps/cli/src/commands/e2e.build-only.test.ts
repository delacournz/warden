import { describe, expect, test } from "bun:test";
import type { Platform } from "@delacour/warden-core/types";
import type { EnsureOptions } from "./app";
import { harness } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import { resuite, setup, useE2eFixture, write } from "./e2e.testing";

useE2eFixture();

type BuildCall = { platform: Platform; opts: EnsureOptions };

/** A harness whose `buildApp` records each call and answers with a cached simulator build. */
function buildHarness(result: "ok" | "fail" = "ok") {
	const h = harness();
	const calls: BuildCall[] = [];
	h.deps.buildApp = async (_ctx, _owner, platform, opts) => {
		calls.push({ platform, opts });
		if (result === "fail") return { success: false, error: "xcodebuild failed (exit 65)" };
		return { success: true, data: { appPath: "/c/A.app", hash: "FP:simulator", source: "build", installed: false } };
	};
	return { h, calls };
}

describe("warden e2e --build-only", () => {
	test("builds the run's app into the cache and stops: no device claimed, no spec run", async () => {
		await resuite({ app: true });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const c = setup(["--build-only"]);
		const { h, calls } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(calls.map((call) => call.platform)).toEqual(["ios"]);
		// the build the run would install: the repacked simulator kind by default
		expect(calls[0]?.opts.kind).toBe("simulator");
		expect(h.jobs()).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("/c/A.app");
	});

	test("--dev builds the dev client, the build a --dev run installs", async () => {
		await resuite({ app: true });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const c = setup(["--build-only", "--dev"]);
		const { h, calls } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(calls[0]?.opts.kind).toBe("dev");
	});

	test("--json prints what was built", async () => {
		await resuite({ app: true });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const c = setup(["--build-only", "--json"]);
		const { h } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			suite: "mobile",
			platform: "ios",
			app: { path: "/c/A.app", hash: "FP:simulator", source: "build" },
		});
	});

	test("a failed build exits 1 with the build's error", async () => {
		await resuite({ app: true });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const c = setup(["--build-only"]);
		const { h } = buildHarness("fail");
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("xcodebuild failed (exit 65)");
		expect(h.jobs()).toEqual([]);
	});

	test("a suite that installs no app has nothing to build", async () => {
		await resuite({ app: false });
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const c = setup(["--build-only", "--json"]);
		const { h, calls } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(calls).toEqual([]);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ suite: "mobile", platform: "ios", app: null });
	});

	test("nothing affected builds nothing: the run it prepares for would not install an app", async () => {
		const c = setup(["--build-only"]);
		const { h, calls } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(calls).toEqual([]);
		expect(c.stderr.join("\n")).toContain("no affected specs");
	});

	test("--build-only and --dry-run can't be combined", async () => {
		const c = setup(["--build-only", "--dry-run"]);
		const { h, calls } = buildHarness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--build-only and --dry-run");
		expect(calls).toEqual([]);
	});
});
