import { describe, expect, test } from "bun:test";
import { createMcpLifecycle, type LifecycleProcess, type ShutdownReason } from "./lifecycle";

type Handler = (arg?: unknown) => void;

/** A fake process: records handlers per event, a settable ppid, exits, and a manual interval clock. */
function fakeProcess(startPpid = 4242) {
	const handlers = new Map<string, Handler[]>();
	const add = (key: string, fn: Handler) => handlers.set(key, [...(handlers.get(key) ?? []), fn]);
	const state = { ppid: startPpid, exits: [] as number[], ticks: [] as (() => void)[], cleared: 0 };
	const proc: LifecycleProcess = {
		stdin: { once: (event, fn) => add(`stdin:${event}`, fn) },
		stdout: { on: (event, fn) => add(`stdout:${event}`, fn as Handler) },
		once: (event, fn) => add(`proc:${event}`, fn),
		on: (event, fn) => add(`proc:${event}`, fn as Handler),
		get ppid() {
			return state.ppid;
		},
		exit: (code) => {
			state.exits.push(code);
		},
	};
	const emit = (key: string, arg?: unknown) => {
		for (const fn of handlers.get(key) ?? []) fn(arg);
	};
	const timers = {
		setInterval: (fn: () => void) => {
			state.ticks.push(fn);
			return state.ticks.length;
		},
		clearInterval: () => {
			state.cleared += 1;
		},
	};
	const tick = () => {
		for (const fn of state.ticks) fn();
	};
	return { proc, state, emit, timers, tick };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function start(startPpid?: number) {
	const fake = fakeProcess(startPpid);
	const reasons: ShutdownReason[] = [];
	let closes = 0;
	const lifecycle = createMcpLifecycle(fake.proc, {
		...fake.timers,
		close: async (reason) => {
			reasons.push(reason);
			closes += 1;
		},
	});
	return { ...fake, lifecycle, reasons, closes: () => closes };
}

describe("createMcpLifecycle", () => {
	const triggers: [string, (f: ReturnType<typeof start>) => void, ShutdownReason["kind"]][] = [
		["SIGTERM", (f) => f.emit("proc:SIGTERM"), "signal"],
		["SIGINT", (f) => f.emit("proc:SIGINT"), "signal"],
		["SIGHUP", (f) => f.emit("proc:SIGHUP"), "signal"],
		["stdin end", (f) => f.emit("stdin:end"), "stdin_closed"],
		["stdin close", (f) => f.emit("stdin:close"), "stdin_closed"],
		[
			"stdout EPIPE",
			(f) => f.emit("stdout:error", Object.assign(new Error("broken"), { code: "EPIPE" })),
			"stdout_closed",
		],
		[
			"parent gone (ppid 1)",
			(f) => {
				f.state.ppid = 1;
				f.tick();
			},
			"parent_gone",
		],
		[
			"reparented to a subreaper",
			(f) => {
				f.state.ppid = 777;
				f.tick();
			},
			"parent_gone",
		],
	];

	for (const [name, fire, kind] of triggers) {
		test(`${name} → exactly one shutdown, exit 0`, async () => {
			const f = start();
			fire(f);
			fire(f);
			f.emit("stdin:end");
			f.emit("proc:SIGTERM");
			await flush();
			expect(f.closes()).toBe(1);
			expect(f.reasons[0]?.kind).toBe(kind);
			expect(f.state.exits).toEqual([0]);
			expect(f.state.cleared).toBe(1);
		});
	}

	test("the ppid poll stays quiet while the parent is the same", async () => {
		const f = start();
		f.tick();
		f.tick();
		await flush();
		expect(f.closes()).toBe(0);
		expect(f.state.exits).toEqual([]);
	});

	test("started already orphaned (ppid 1) → first poll shuts down", async () => {
		const f = start(1);
		f.tick();
		await flush();
		expect(f.reasons[0]?.kind).toBe("parent_gone");
	});

	test("an uncaught error exits 1", async () => {
		const f = start();
		f.emit("proc:uncaughtException", new Error("boom"));
		await flush();
		expect(f.reasons[0]).toMatchObject({ kind: "error", message: "boom" });
		expect(f.state.exits).toEqual([1]);
	});

	test("a stdout error other than EPIPE after shutdown is swallowed, not a second shutdown", async () => {
		const f = start();
		f.emit("stdin:end");
		f.emit("stdout:error", new Error("other"));
		await flush();
		expect(f.closes()).toBe(1);
		expect(f.state.exits).toEqual([0]);
	});

	test("shutdown() by hand (transport closed) is idempotent with the triggers", async () => {
		const f = start();
		await Promise.all([
			f.lifecycle.shutdown({ kind: "transport_closed" }),
			f.lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" }),
		]);
		f.emit("stdin:end");
		await flush();
		expect(f.closes()).toBe(1);
		expect(f.reasons[0]?.kind).toBe("transport_closed");
		expect(f.state.exits).toEqual([0]);
		expect(f.lifecycle.stopped()).toBe(true);
	});

	test("a close that throws or hangs still exits", async () => {
		const fake = fakeProcess();
		const lifecycle = createMcpLifecycle(fake.proc, {
			...fake.timers,
			closeTimeoutMs: 20,
			close: () => new Promise<void>(() => undefined),
		});
		await lifecycle.shutdown({ kind: "stdin_closed" });
		expect(fake.state.exits).toEqual([0]);

		const fake2 = fakeProcess();
		const lifecycle2 = createMcpLifecycle(fake2.proc, {
			...fake2.timers,
			close: async () => {
				throw new Error("nope");
			},
		});
		await lifecycle2.shutdown({ kind: "stdin_closed" });
		expect(fake2.state.exits).toEqual([0]);
	});
});
