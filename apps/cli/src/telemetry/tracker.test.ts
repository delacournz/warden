import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { Command, type CommandUnknownOpts } from "@commander-js/extra-typings";
import type { RecordedEvent, Telemetry } from "@delacournz/cli-telemetry";
import { createTracker } from "./tracker";

class DeviceFailure extends Error {}

type Fake = { telemetry: Telemetry; recorded: RecordedEvent[]; flushes: (number | undefined)[]; marks: () => number };

function fake(options: { enabled?: boolean; showNotice?: boolean } = {}): Fake {
	const recorded: RecordedEvent[] = [];
	const flushes: (number | undefined)[] = [];
	let marks = 0;
	const enabled = options.enabled ?? true;
	const telemetry: Telemetry = {
		enabled,
		reason: enabled ? "default" : "do-not-track",
		noticeText: "NOTICE\n",
		status: () => {
			throw new Error("unused");
		},
		record: (event) => {
			recorded.push(event);
		},
		flush: async (flushOptions) => {
			flushes.push(flushOptions?.timeoutMs);
		},
		enable: () => {},
		disable: () => {},
		shouldShowNotice: () => enabled && (options.showNotice ?? false),
		markNoticeShown: () => {
			marks++;
		},
	};
	return { telemetry, recorded, flushes, marks: () => marks };
}

function actionCommand(path: string[], argv: string[]): CommandUnknownOpts {
	let seen: CommandUnknownOpts | undefined;
	const program = new Command().name("warden").exitOverride();
	let node: Command = program;
	for (const name of path.slice(0, -1)) node = node.command(name);
	node
		.command(path[path.length - 1] as string)
		.argument("[args...]")
		.option("--json")
		.option("--quiet")
		.option("--follow")
		.option("--platform <platform>")
		.option("--label <label>")
		.action((_args, _opts, command) => {
			seen = command;
		});
	program.parse([...path, ...argv], { from: "user" });
	if (!seen) throw new Error("action did not run");
	return seen;
}

function tracker(f: Fake, writes: string[] = []) {
	let clock = 1000;
	return createTracker({
		telemetry: async () => f.telemetry,
		stderr: (line) => void writes.push(line),
		now: () => {
			clock += 250;
			return clock;
		},
	});
}

describe("tracker", () => {
	test("records one command event with the path, flag names, platform and json, then flushes at 1.5 s", async () => {
		const f = fake();
		const t = tracker(f);
		await t.begin(actionCommand(["ui", "press"], ["@e3", "--json", "--label", "Secret", "--platform", "ios"]));
		await t.finish({ outcome: "success" });

		expect(f.recorded).toEqual([
			{
				name: "command",
				outcome: "success",
				durationMs: 250,
				properties: { command: "ui press", flags: ["--json", "--label", "--platform"], json: true, platform: "ios" },
			},
		]);
		expect(JSON.stringify(f.recorded)).not.toContain("Secret");
		expect(JSON.stringify(f.recorded)).not.toContain("@e3");
		expect(f.flushes).toEqual([1500]);
	});

	test("an error carries the class name and exit code, never the message", async () => {
		const f = fake();
		const t = tracker(f);
		await t.begin(actionCommand(["claim"], []));
		await t.finish({ outcome: "error", error: new DeviceFailure("/Users/me/x"), exitCode: 1 });

		expect(f.recorded[0]?.outcome).toBe("error");
		expect(f.recorded[0]?.properties).toMatchObject({ errorKind: "DeviceFailure", exitCode: 1 });
		expect(JSON.stringify(f.recorded)).not.toContain("/Users/me");
	});

	test("counts e2e suites, not their names", async () => {
		const f = fake();
		const t = tracker(f);
		await t.begin(actionCommand(["e2e"], ["login", "checkout"]));
		await t.finish({ outcome: "success" });

		expect(f.recorded[0]?.properties).toMatchObject({ suites: 2 });
		expect(JSON.stringify(f.recorded)).not.toContain("checkout");
	});

	test("never counts telemetry, hook, heartbeat, complete, hidden workers", async () => {
		for (const path of [
			["telemetry"],
			["version"],
			["hook"],
			["heartbeat"],
			["complete"],
			["__scheduler"],
			["perf-collect"],
		]) {
			const f = fake({ showNotice: true });
			const t = tracker(f);
			await t.begin(actionCommand(path, []));
			await t.finish({ outcome: "success" });
			expect(f.recorded).toEqual([]);
			expect(f.flushes).toEqual([]);
			expect(f.marks()).toBe(0);
		}
	});

	test("long-running commands (dev, mcp, --follow) record and flush at the start, and finish adds nothing", async () => {
		for (const [path, argv] of [
			[["dev"], []],
			[["mcp"], []],
			[["events"], ["--follow"]],
		] as const) {
			const f = fake();
			const t = tracker(f);
			await t.begin(actionCommand([...path], [...argv]));
			expect(f.recorded).toHaveLength(1);
			expect(f.flushes).toEqual([1500]);
			await t.finish({ outcome: "success" });
			expect(f.recorded).toHaveLength(1);
		}
	});

	test("shows the notice once on stderr and marks it", async () => {
		const f = fake({ showNotice: true });
		const writes: string[] = [];
		await tracker(f, writes).begin(actionCommand(["claim"], []));

		expect(writes.join("")).toContain("NOTICE");
		expect(f.marks()).toBe(1);
	});

	test("holds the notice under --quiet but still counts the run", async () => {
		const f = fake({ showNotice: true });
		const writes: string[] = [];
		const t = tracker(f, writes);
		await t.begin(actionCommand(["claim"], ["--quiet"]));
		await t.finish({ outcome: "success" });

		expect(writes).toEqual([]);
		expect(f.marks()).toBe(0);
		expect(f.recorded).toHaveLength(1);
	});

	test("records nothing and flushes nothing while disabled", async () => {
		const f = fake({ enabled: false });
		const t = tracker(f);
		await t.begin(actionCommand(["claim"], []));
		await t.finish({ outcome: "success" });

		expect(f.recorded).toEqual([]);
		expect(f.flushes).toEqual([]);
	});

	test("does nothing when the client says telemetry is certainly off", async () => {
		const t = createTracker({ telemetry: async () => undefined, stderr: () => assert.fail("wrote") });
		await t.begin(actionCommand(["claim"], []));
		await t.finish({ outcome: "success" });
	});

	test("finish without begin does nothing, and nothing ever throws", async () => {
		const f = fake();
		const t = tracker(f);
		await t.finish({ outcome: "success" });
		expect(f.recorded).toEqual([]);

		const broken = createTracker({
			telemetry: async () => {
				throw new Error("import failed");
			},
			stderr: () => {},
		});
		await broken.begin(actionCommand(["claim"], []));
		await broken.finish({ outcome: "error", error: new Error("x") });
	});
});
