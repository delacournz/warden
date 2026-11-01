import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFixtures, FakeDriver } from "@delacour/warden-driver/testing/driver";
import type { DeviceProvider } from "@delacour/warden-providers/provider.types";
import type { ExecResult } from "@delacour/warden-runtime/exec";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { wardenErrors } from "@delacour/warden-types/error";
import { resultFactory } from "@delacour/warden-types/result";
import { createWardenClient } from "./client";
import {
	perfCrashesResultSchema,
	perfFramesResultSchema,
	perfLogsResultSchema,
	perfMarkResultSchema,
	perfMemoryResultSchema,
	perfReportSchema,
	perfSessionRowSchema,
	perfStartResultSchema,
	perfStartupResultSchema,
	perfStopResultSchema,
} from "./contracts/perf.schema";
import type { ClientSeams } from "./core";
import { isWardenError } from "./errors";
import type { SessionKit } from "./ops/perf/orchestrate";
import { listSessions, updateSession } from "./ops/perf/session";
import type { PerfEngineDeps } from "./ops/perf/types";
import type { Session } from "./sdk.types";

const SERIAL = "emulator-5554";
const APP = "com.acme.shop";
const fx = (name: string) => readFileSync(new URL(`../../perf/fixtures/${name}`, import.meta.url), "utf8");

let home: string;
const stores: Store[] = [];
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-sdk-perf-"));
});

const provider: DeviceProvider = {
	platform: "android",
	inventory: async () =>
		resultFactory.ok([
			{
				platform: "android",
				id: SERIAL,
				name: "warden-pixel-9-1",
				state: "booted",
				wardenCreated: true,
				runtime: "android-35",
			},
		]),
	create: async () => wardenErrors.err("failed", "no create"),
	boot: async () => resultFactory.ok(undefined),
	waitReady: async () => resultFactory.ok(undefined),
	shutdown: async () => resultFactory.ok(undefined),
};

type Rule = [needle: string, result: Partial<ExecResult>];

/** An exec that answers by substring and records every call. */
function fakeExec(rules: Rule[]) {
	const calls: string[] = [];
	const exec = async (cmd: readonly string[]): Promise<ExecResult> => {
		const line = cmd.join(" ");
		calls.push(line);
		const hit = rules.find(([needle]) => line.includes(needle));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `no rule: ${line}` };
		return { exitCode: 0, stdout: "", stderr: "", ...hit[1] };
	};
	return { exec, calls };
}

/** A fake process table: the collector `spawnDetached` registers stays alive until killed. */
function fakeProcs(store: Store) {
	const alive = new Set<number>();
	const commands = new Map<number, string>();
	const spawned: string[][] = [];
	let n = 0;
	const deps: PerfEngineDeps = {
		host: { platform: "darwin", metro: async () => undefined },
		session: {
			pidAlive: (pid) => alive.has(pid),
			command: (pid) => commands.get(pid),
			kill: (pid) => {
				alive.delete(pid);
			},
			random: () => (++n).toString(16).padStart(6, "0"),
		},
	};
	const kit: SessionKit = {
		io: {
			spawnDetached: ({ argv }) => {
				spawned.push(argv);
				const id = argv[argv.indexOf("--session") + 1] ?? "";
				alive.add(4242);
				commands.set(4242, `warden perf-collect --session ${id}`);
				return { pid: 4242 };
			},
			kill: () => {},
			pidAlive: (pid) => alive.has(pid),
			sleep: async () => {
				const ctx = { env: { WARDEN_HOME: home }, now: Date.now, store: () => store };
				const open = listSessions(ctx)[0];
				if (open === undefined) return;
				for (const kind of ["metrics", "logs"] as const) {
					if (!open.capturers.some((c) => c.kind === kind))
						updateSession(ctx, open.id, (s) => ({
							...s,
							capturers: [...s.capturers, { kind, startedAtIso: "x", state: "running" as const }],
						}));
				}
			},
			self: () => ["warden"],
		},
		profilers: {
			ios: async () => {
				throw new Error("unused");
			},
			android: async () => {
				throw new Error("unused");
			},
		},
	};
	return { deps, kit, spawned };
}

async function open(rules: Rule[], extra: Partial<ClientSeams> = {}) {
	const { exec, calls } = fakeExec([
		["-list-avds", { stdout: "Pixel_9\n" }],
		["date +%s%N", { stdout: `${Date.now() * 1_000_000}\n` }],
		["pidof", { stdout: "4321\n" }],
		["logcat", { stdout: fx("logcat-app-threadtime.txt") }],
		["gfxinfo", { stdout: fx("gfxinfo-60hz.txt") }],
		["logcat -b crash", { stdout: "" }],
		["dumpsys dropbox", { stdout: "" }],
		...rules,
	]);
	const store = storeLocator.open(join(home, "warden.db"));
	stores.push(store);
	const procs = fakeProcs(store);
	const seams: ClientSeams = {
		providerFor: () => provider,
		stopHelper: async () => undefined,
		store,
		openDriver: async () => resultFactory.ok(new FakeDriver({ screens: [driverFixtures.snapshotOf([])] })),
		...extra,
		perf: { deps: procs.deps, kit: procs.kit, ...extra.perf },
	};
	const warden = createWardenClient(
		{
			home,
			host: {
				env: {
					WARDEN_CAPACITY: "off",
					WARDEN_ARRANGE: "0",
					WARDEN_BACKGROUND: "0",
					WARDEN_HOME: home,
					HOME: "/nonexistent",
				},
				cwd: home,
				exec,
			},
		},
		seams
	);
	const [lease] = await warden.leases.claim({ platform: "android" });
	const session = await warden.sessions.open({ lease: lease as NonNullable<typeof lease>, app: APP });
	return { warden, session, calls, procs };
}

async function rejection(work: Promise<unknown>) {
	try {
		await work;
	} catch (error) {
		if (isWardenError(error)) return error;
		throw error;
	}
	throw new Error("expected a WardenError");
}

const live: Array<{ warden: { close: () => Promise<void> }; session: Session }> = [];
afterEach(async () => {
	for (const l of live.splice(0)) {
		await l.session.close();
		await l.warden.close();
	}
	for (const store of stores.splice(0)) store.close();
	rmSync(home, { recursive: true, force: true });
});
async function ready(rules: Rule[] = [], extra: Partial<ClientSeams> = {}) {
	const o = await open(rules, extra);
	live.push(o);
	return o;
}

test("start, mark, status, stop and report run a session on the leased device", async () => {
	const { warden, session, procs } = await ready();
	const started = await session.perf.start({ metrics: true, logs: true });
	expect(started).toMatchObject({ app: APP, warnings: [] });
	expect(started.capturers.map((c) => c.kind)).toContain("collector");
	expect(procs.spawned).toHaveLength(1);
	expect(() => perfStartResultSchema.parse(started)).not.toThrow();

	const marked = await session.perf.mark("open cart");
	expect(marked).toMatchObject({ label: "open cart", sessionId: started.sessionId });
	expect(() => perfMarkResultSchema.parse(marked)).not.toThrow();

	const status = await session.perf.status();
	expect(status).toMatchObject({ id: started.sessionId, status: "running", marks: 1, device: SERIAL });

	const stopped = await session.perf.stop();
	expect(stopped).toMatchObject({ sessionId: started.sessionId, status: "stopped", stopReason: "user" });
	expect(stopped.report?.sessionId).toBe(started.sessionId);
	expect(() => perfStopResultSchema.parse(stopped)).not.toThrow();
	expect(await session.perf.status()).toBeNull();

	const rows = await warden.perf.ls();
	expect(rows.map((r) => r.id)).toEqual([started.sessionId]);
	for (const row of rows) expect(() => perfSessionRowSchema.parse(row)).not.toThrow();
	const report = await warden.perf.report("latest");
	expect(report.sessionId).toBe(started.sessionId);
	expect(() => perfReportSchema.parse(report)).not.toThrow();
});

test("a second start is session_active, stop without a session is session_not_found", async () => {
	const { session } = await ready();
	expect((await rejection(session.perf.stop())).code).toBe("session_not_found");
	await session.perf.start({ metrics: true });
	expect((await rejection(session.perf.start({ metrics: true }))).code).toBe("session_active");
	expect((await rejection(session.perf.mark("  "))).code).toBe("usage");
});

test("closing the session stops the perf session it started", async () => {
	const { warden, session } = await ready();
	const started = await session.perf.start({ metrics: true });
	await session.close();
	const [row] = await warden.perf.ls();
	expect(row).toMatchObject({ id: started.sessionId, status: "stopped" });
});

const logDeps = {
	spawn: (_argv: string[], onLine: (line: string) => void) => {
		for (const line of fx("logcat-app-threadtime.txt").split("\n")) onLine(line);
		let release: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			release = resolve;
		});
		return { kill: () => release(0), exited };
	},
	sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
	interrupt: () => ({ signal: new AbortController().signal, dispose: () => {} }),
};

test("logs returns redacted entries; follow streams until the signal aborts", async () => {
	const { session } = await ready([], { perf: { logs: logDeps } });
	const once = await session.perf.logs({ lines: 3 });
	expect(once).toMatchObject({ app: APP });
	expect(once.entries.length).toBeGreaterThan(0);
	expect(once.entries.length).toBeLessThanOrEqual(3);
	expect(() => perfLogsResultSchema.parse(once)).not.toThrow();

	const controller = new AbortController();
	const seen: string[] = [];
	for await (const entry of session.perf.logs({ follow: true }, { signal: controller.signal })) {
		seen.push(entry.msg);
		if (seen.length >= 2) controller.abort();
	}
	expect(seen.length).toBeGreaterThanOrEqual(2);
});

test("bad parameters are usage errors; a closed session refuses", async () => {
	const { session } = await ready();
	expect((await rejection(session.perf.startup({ runs: 99 }))).code).toBe("usage");
	expect((await rejection(session.perf.startup({ method: "xctrace" }))).code).toBe("usage");
	expect((await rejection(session.perf.metrics({ interval: "10ms" }))).code).toBe("usage");
	expect((await rejection(session.perf.logs({ level: "loud" as never }))).code).toBe("usage");
	const aborted = AbortSignal.abort();
	expect((await rejection(session.perf.status({ signal: aborted }))).code).toBe("interrupted");
	await session.close();
	expect((await rejection(session.perf.status())).code).toBe("usage");
});

test("perf.report of an unknown session is session_not_found", async () => {
	const { warden } = await ready();
	expect((await rejection(warden.perf.report("nope"))).code).toBe("session_not_found");
	expect(await warden.perf.ls({ device: "other" })).toEqual([]);
});

test("crashes reads an empty crash log", async () => {
	const { session } = await ready();
	const crashes = await session.perf.crashes();
	expect(crashes).toMatchObject({ app: APP, count: 0, crashes: [] });
	expect(() => perfCrashesResultSchema.parse(crashes)).not.toThrow();
});

test("frames and memory read the app through adb", async () => {
	const { session } = await ready([["dumpsys meminfo", { stdout: fx("dumpsys-meminfo.txt") }]]);
	const frames = await session.perf.frames();
	expect(frames).toMatchObject({ status: "ok", app: APP, reset: false });
	expect(() => perfFramesResultSchema.parse(frames)).not.toThrow();
	const memory = await session.perf.memory();
	expect(memory).toMatchObject({ app: APP });
	expect(memory.meminfo).toBeDefined();
	expect(() => perfMemoryResultSchema.parse(memory)).not.toThrow();
});

test("startup times cold launches and writes its report", async () => {
	const { session } = await ready([
		["force-stop", {}],
		["resolve-activity", { stdout: fx("resolve-activity.txt") }],
		["am start", { stdout: fx("am-start-cold.txt") }],
	]);
	const result = await session.perf.startup({ runs: 2 });
	expect(result).toMatchObject({ appId: APP, method: "am-start" });
	expect(result.runs).toHaveLength(2);
	expect(result.summary.cold).toBeDefined();
	expect(() => perfStartupResultSchema.parse(result)).not.toThrow();
});
