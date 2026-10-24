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
		expect(calls.filter((cmd) => cmd[0] === "osascript")).toHaveLength(2);
	});

	test("--json", async () => {
		ctx = testContext(["--json"], { exec: windowsExec(["warden-iphone-17-1 – iOS 26.5"]) });
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({ arranged: ["warden-iphone-17-1"], viewer: "simulator" });
	});

	test("no windows → says so, exit 0", async () => {
		ctx = testContext([], { exec: windowsExec([]) });
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("no warden simulator windows open");
	});

	test("osascript failure → exit 1", async () => {
		ctx = testContext([], {
			exec: async (cmd) =>
				cmd[0] === "pgrep" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 1, stdout: "", stderr: "boom" },
		});
		expect(await arrangeCommand.run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("warden arrange:");
	});

	/** Device Hub running, its windows read as `windows` (screen 1440x900) */
	const deviceHub = (windows: { title: string; width: number; height: number }[], calls: string[][] = []) =>
		testContext(["--json"], {
			exec: async (cmd) => {
				calls.push([...cmd]);
				if (cmd[0] === "pgrep") return { exitCode: cmd[2] === "DeviceHub" ? 0 : 1, stdout: "", stderr: "" };
				const screen = { x: 0, y: 25, width: 1440, height: 875 };
				return { exitCode: 0, stdout: JSON.stringify({ screen, windows }), stderr: "" };
			},
		});

	test("Xcode 27 Device Hub → tiles its per-device windows and reports them, viewer device-hub", async () => {
		const calls: string[][] = [];
		ctx = deviceHub(
			[
				{ title: "warden-iphone-17-2 – iOS 27.1", width: 340, height: 751 },
				{ title: "warden-iphone-17-1 – iOS 27.1", width: 340, height: 751 },
			],
			calls
		);
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({
			arranged: ["warden-iphone-17-1", "warden-iphone-17-2"],
			viewer: "device-hub",
		});
		expect(calls.filter((cmd) => cmd[0] === "osascript")).toHaveLength(2);
	});

	test("Xcode 27 Device Hub without device windows → nothing arranged, no move", async () => {
		const calls: string[][] = [];
		ctx = deviceHub([], calls);
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({ arranged: [], viewer: "device-hub" });
		expect(calls.filter((cmd) => cmd[0] === "osascript")).toHaveLength(1);
	});

	test("no viewer running → nothing to arrange without starting osascript", async () => {
		const calls: string[][] = [];
		ctx = testContext([], {
			exec: async (cmd) => {
				calls.push([...cmd]);
				return { exitCode: cmd[0] === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
			},
		});
		expect(await arrangeCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("no warden simulator windows open");
		expect(calls).toEqual([
			["pgrep", "-xq", "Simulator"],
			["pgrep", "-xq", "DeviceHub"],
		]);
	});
});
