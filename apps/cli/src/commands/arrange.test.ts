import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import { type TestContext, testContext } from "../testing";
import { arrangeCommand } from "./arrange";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const screen = { x: 0, y: 33, width: 1728, height: 1021 };
const windowsExec = (titles: string[], calls: string[][] = []): Exec => {
	return async (cmd) => {
		calls.push([...cmd]);
		if (!(cmd[4] ?? "").includes("NSScreen")) return { exitCode: 0, stdout: "", stderr: "" };
		const windows = titles.map((title) => ({ title, width: 456, height: 972 }));
		return { exitCode: 0, stdout: JSON.stringify({ screen, windows }), stderr: "" };
	};
};

describe("warden arrange", () => {
	test("tiles warden sim windows and lists them in order", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: windowsExec(["warden-iphone-17-2 – iOS 26.5", "warden-iphone-17-1 – iOS 26.5"], calls),
		});
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("warden-iphone-17-1, warden-iphone-17-2");
		expect(calls).toHaveLength(2);
	});

	test("--json", async () => {
		ctx = testContext(["--json"], { exec: windowsExec(["warden-iphone-17-1 – iOS 26.5"]) });
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({ arranged: ["warden-iphone-17-1"] });
	});

	test("no windows → says so, exit 0", async () => {
		ctx = testContext([], { exec: windowsExec([]) });
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("no warden simulator windows open");
	});

	test("osascript failure → exit 1", async () => {
		ctx = testContext([], { exec: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) });
		expect(await arrangeCommand.run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("warden arrange:");
	});
});
