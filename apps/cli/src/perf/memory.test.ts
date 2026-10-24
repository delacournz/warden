import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type TestContext, testContext } from "../testing";
import { type MemoryIo, perfMemory } from "./memory";
import { asMe, fakePerfDeps, ME } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");
const APP = "nz.co.delacour.warden.example";
const T0 = 7_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;
const droid = { platform: "android", id: "emulator-5554", name: "warden-pixel-1" } as const;
const io: MemoryIo = { sleep: async () => {} };

type Script = (cmd: string) => Partial<ExecResult> | undefined;

function setup(device: typeof sim | typeof droid, script: Script, leased: boolean) {
	const calls: string[] = [];
	const c = testContext([], {
		now: () => T0,
		exec: async (cmd) => {
			const joined = cmd.join(" ");
			calls.push(joined);
			const hit = script(joined);
			return hit === undefined
				? { exitCode: 127, stdout: "", stderr: `no handler: ${joined}` }
				: { exitCode: 0, stdout: "", stderr: "", ...hit };
		},
	});
	ctx = c;
	asMe(c);
	c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, T0);
	if (leased) {
		c.db.insertLease(
			{
				resource: { kind: "device", platform: device.platform, id: device.id, name: device.name },
				owner: ME,
				ttlMs: 600_000,
			},
			T0
		);
	}
	return { c, calls, deps: fakePerfDeps([device]) };
}

const json = (c: TestContext) => JSON.parse(c.stdout[c.stdout.length - 1] ?? "null");

const iosScript =
	(extra: Script = () => undefined): Script =>
	(cmd) => {
		if (cmd.includes("launchctl list")) return { stdout: fx("launchctl-list-two-apps.txt") };
		if (cmd.includes("vmmap --summary 880")) return { stdout: fx("vmmap-summary.txt") };
		return extra(cmd);
	};

describe("warden perf memory (iOS)", () => {
	test("plain: footprint and top regions from vmmap, observe-only (no lease needed, none taken)", async () => {
		const { c, deps } = setup(sim, iosScript(), false);
		expect(await perfMemory(c, deps, { app: APP }, io)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain(`${APP} (pid 880): footprint 168.4 MB (peak 181.9 MB)`);
		expect(text).toContain("MALLOC_SMALL");
		expect(text).toContain("next: warden perf memory --snapshot");
		expect(c.db.listLeases().length).toBe(0);
	});

	test("not running: app_not_found", async () => {
		const { c, deps } = setup(
			sim,
			(cmd) => (cmd.includes("launchctl list") ? { stdout: "PID\tStatus\tLabel\n" } : undefined),
			false
		);
		expect(await perfMemory(c, deps, { app: APP, json: true }, io)).toBe(1);
		expect(json(c)).toMatchObject({ ok: false, error: { code: "app_not_found" } });
	});

	test("--snapshot without your own lease: device_foreign-style refusal, nothing captured", async () => {
		const { c, deps, calls } = setup(sim, iosScript(), false);
		const code = await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io);
		expect(code).not.toBe(0);
		expect(calls.some((cmd) => cmd.includes("leaks"))).toBe(false);
	});

	test("--snapshot on your lease: leaks --outputGraph into the one-shot dir, leak finding", async () => {
		const { c, deps, calls } = setup(
			sim,
			iosScript((cmd) => (cmd.includes(" leaks ") ? { exitCode: 1, stdout: fx("leaks-summary.txt") } : undefined)),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(0);
		const doc = json(c);
		const leaksCall = calls.find((cmd) => cmd.includes(" leaks ")) ?? "";
		expect(leaksCall).toContain("xcrun simctl spawn U1 leaks --outputGraph=");
		expect(leaksCall.endsWith(" 880")).toBe(true);
		expect(doc.result.memgraph).toBe(leaksCall.split("--outputGraph=")[1]?.split(" ")[0]);
		expect(doc.result.memgraph).toContain(join("perf", "memory-"));
		expect(doc.result.leaks).toMatchObject({ leakCount: 3, leakedBytes: 224 });
		expect(doc.result.findings[0]).toMatchObject({ kind: "leak", type: "NSMutableArray", count: 3 });
	});

	test("--snapshot with no leaks: leaks: none, exit 0 from leaks itself", async () => {
		const { c, deps } = setup(
			sim,
			iosScript((cmd) => (cmd.includes(" leaks ") ? { stdout: fx("leaks-clean.txt") } : undefined)),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, snapshot: true }, io)).toBe(0);
		expect(c.stdout.join("\n")).toContain("leaks: none");
	});

	test("leaks failing without a summary is an error carrying its message", async () => {
		const { c, deps } = setup(
			sim,
			iosScript((cmd) =>
				cmd.includes(" leaks ") ? { exitCode: 2, stderr: "leaks: cannot examine process" } : undefined
			),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(1);
		expect(json(c).error.message).toContain("cannot examine process");
	});
});

describe("warden perf memory (Android)", () => {
	const hprofScript = (opts: { dump?: Partial<ExecResult>; sizes?: string[] } = {}): Script => {
		const sizes = [...(opts.sizes ?? ["0", "2048000", "4096000", "4096000"])];
		const handlers: Array<[string, () => Partial<ExecResult>]> = [
			["dumpsys meminfo", () => ({ stdout: fx("dumpsys-meminfo.txt") })],
			["am dumpheap", () => opts.dump ?? { stdout: "File: /data/local/tmp/x.hprof\n" }],
			["stat -c %s", () => ({ stdout: `${sizes.shift() ?? "4096000"}\n` })],
			[" pull ", () => ({ stdout: "1 file pulled\n" })],
			["touch", () => ({})],
			["chmod", () => ({})],
			["rm -f", () => ({})],
		];
		return (cmd) => handlers.find(([key]) => cmd.includes(key))?.[1]();
	};

	test("plain: PSS/RSS and the top 5 categories", async () => {
		const { c, deps } = setup(droid, hprofScript(), false);
		expect(await perfMemory(c, deps, { app: APP }, io)).toBe(0);
		const text = c.stdout.join("\n");
		expect(text).toContain("PSS 222.8 MB, RSS 314.9 MB");
		expect(text).toContain("Graphics");
		expect(text.split("\n").filter((l) => l.startsWith("  ")).length).toBe(5);
	});

	test("--snapshot: touch+chmod, dumpheap, wait for the size to settle, pull, rm", async () => {
		const { c, deps, calls } = setup(droid, hprofScript(), true);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(0);
		const doc = json(c);
		expect(doc.result.hprof.bytes).toBe(4096000);
		expect(doc.result.hprof.path).toContain(join("perf", "memory-"));
		expect(doc.result.hprof.path).toMatch(/\.hprof$/);
		const order = ["touch", "chmod", "am dumpheap", "stat -c", " pull ", "rm -f"].map((k) =>
			calls.findIndex((cmd) => cmd.includes(k))
		);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(calls[order[2] ?? 0]).toContain(`am dumpheap ${APP} /data/local/tmp/warden-${APP}-`);
	});

	test("the device copy is removed even when the pull fails", async () => {
		const script = hprofScript();
		const { c, deps, calls } = setup(
			droid,
			(cmd) => (cmd.includes(" pull ") ? { exitCode: 1, stderr: "remote object does not exist" } : script(cmd)),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(1);
		expect(calls.some((cmd) => cmd.includes("rm -f /data/local/tmp/warden-"))).toBe(true);
	});

	test("a non-debuggable app: not_profileable with a manifest hint", async () => {
		const { c, deps } = setup(
			droid,
			hprofScript({
				dump: {
					exitCode: 1,
					stderr: "java.lang.SecurityException: Process not debuggable, and not profileable by shell",
				},
			}),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(1);
		const err = json(c).error;
		expect(err.code).toBe("not_profileable");
		expect(err.hint).toContain("profileable");
	});

	test("a dump that never settles times out instead of hanging", async () => {
		let n = 0;
		const script = hprofScript();
		const { c, deps } = setup(
			droid,
			(cmd) => (cmd.includes("stat -c") ? { stdout: `${++n * 1000}\n` } : script(cmd)),
			true
		);
		expect(await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io)).toBe(1);
		expect(json(c).error.message).toContain("did not finish");
	});

	test("the session dir is used when a session is active", async () => {
		const { c, deps, calls } = setup(droid, hprofScript(), true);
		const { createSession } = await import("./session");
		const made = createSession(c, deps.session, {
			device: { udid: droid.id, platform: "android", name: droid.name },
			target: { udid: droid.id, ownedByCaller: true },
			maxDurationMs: 60_000,
		});
		if (!made.success) throw new Error("create");
		await perfMemory(c, deps, { app: APP, json: true, snapshot: true }, io);
		const dir = join(c.env.WARDEN_HOME ?? "", "perf", made.data.id, "native");
		expect(existsSync(dir)).toBe(true);
		expect(calls.find((cmd) => cmd.includes(" pull "))).toContain(`${dir}/${APP}-`);
	});
});
