import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { createDevCommand, defaultDevDeps } from "./dev";
import { hostDevConflicts } from "./dev-host";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

describe("hostDevConflicts", () => {
	test("names the flags a host run can't honour", () => {
		expect(hostDevConflicts({})).toEqual([]);
		expect(hostDevConflicts({ udid: "U", installMode: "fresh", hud: true, devtools: false })).toEqual([
			"--udid",
			"--install-mode",
			"--hud",
		]);
	});
});

describe("warden dev --host", () => {
	test("refuses the flags it can't honour before anything is read or leased", async () => {
		const ctx = testContext(["ios", "--host", "mac", "--udid", "U1", "--lease", "L1"]);
		ctxs.push(ctx);
		expect(await createDevCommand(defaultDevDeps).run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("--host can't be used with --udid, --lease");
		expect(ctx.db.listLeases()).toEqual([]);
	});
});
