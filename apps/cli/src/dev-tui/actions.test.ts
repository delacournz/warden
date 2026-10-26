import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import type { DevReady } from "../commands/dev-ui";
import {
	type ActionEffects,
	type ActionFailure,
	type ActionSink,
	createActions,
	type FxResult,
	type PerfStarted,
	type PerfStopped,
} from "./actions";
import type { HudPerf } from "./model";

const IOS: DevReady = {
	platform: "ios",
	deviceId: "UDID-1",
	deviceName: "warden-iphone",
	port: 8101,
	metroUrl: "http://127.0.0.1:8101",
	leaseIds: ["l1"],
	app: undefined,
	projectName: "example",
	bundleId: "com.example.app",
};
const ANDROID: DevReady = { ...IOS, platform: "android", deviceId: "emulator-5554" };

type Call = string;

const fail = (message: string, code?: ActionFailure["code"]): { success: false; error: ActionFailure } => ({
	success: false,
	error: { message, ...(code ? { code } : {}) },
});

const STARTED: PerfStarted = {
	sessionId: "perf-1",
	startedAt: 10_000,
	maxDurationMs: 300_000,
	armed: ["metrics", "logs"],
	failed: [],
	warnings: [],
};
const STOPPED: PerfStopped = {
	reportPath: "/home/perf/perf-1/report.md",
	lines: ["# report", "cpu 12%"],
	warnings: [],
};

function setup(info: DevReady | null = IOS, overrides: Partial<ActionEffects> = {}) {
	const calls: Call[] = [];
	const events: string[] = [];
	const rows = new Map<string, { title: string; status: string; log: string[] }>();
	let hudPerf: HudPerf | undefined;
	let clock = 10_000;
	const tickers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
	const touch = (id: string) => {
		let row = rows.get(id);
		if (!row) {
			row = { title: id, status: "pending", log: [] };
			rows.set(id, row);
		}
		return row;
	};
	const sink: ActionSink = {
		start: (id, title) => {
			Object.assign(touch(id), { title, status: "running" });
			events.push(`start ${id}`);
		},
		log: (id, line) => touch(id).log.push(line),
		title: (id, title) => {
			touch(id).title = title;
		},
		ok: (id, detail) => {
			touch(id).status = "ok";
			if (detail) touch(id).log.push(detail);
		},
		fail: (id, error) => {
			touch(id).status = "fail";
			touch(id).log.push(error);
		},
		hudPerf: (perf) => {
			hudPerf = perf;
		},
		prompt: (label) => events.push(`prompt ${label}`),
	};
	const done = <T>(name: string, value: T): FxResult<T> => {
		calls.push(name);
		return Promise.resolve(ok(value));
	};
	const fx: ActionEffects = {
		metroWrite: (data) => {
			calls.push(`metroWrite ${data}`);
			return true;
		},
		reveal: () => done("reveal", undefined),
		screenshot: () => done("screenshot", "/home/dev/l1/shots/001.png"),
		openClient: () => done("openClient", undefined),
		reinstall: () => done("reinstall", { source: "cache", hash: "abc" }),
		restartSim: () => done("restartSim", undefined),
		restartMetro: () => done("restartMetro", "http://127.0.0.1:8101"),
		streamLogs: () => {
			calls.push("streamLogs");
			return { stop: () => calls.push("logs stop"), done: new Promise<string | undefined>(() => undefined) };
		},
		perfStart: (_i, mode) => done(`perfStart ${mode}`, STARTED),
		perfStop: (_i, id) => done(`perfStop ${id}`, STOPPED),
		perfMark: (_i, label) => done(`perfMark ${label}`, undefined),
		frames: () => done("frames", undefined),
		report: () => done("report", undefined),
		...overrides,
	};
	const actions = createActions({
		now: () => clock,
		ready: () => info ?? undefined,
		sink,
		fx,
		every: (fn, ms) => {
			const entry = { fn, ms, live: true };
			tickers.push(entry);
			return () => {
				entry.live = false;
			};
		},
	});
	return {
		actions,
		calls,
		events,
		rows,
		row: (id: string) => rows.get(id),
		hud: () => hudPerf,
		advance: (ms: number) => {
			clock += ms;
		},
		tick: () => {
			for (const t of tickers) if (t.live) t.fn();
		},
		liveTickers: () => tickers.filter((t) => t.live).length,
	};
}

describe("reload", () => {
	test("writes r to Metro and logs once on the metro row", async () => {
		const t = setup();
		await t.actions.run("reload");
		expect(t.calls).toEqual(["metroWrite r"]);
		expect(t.row("metro")?.log).toEqual(["reload sent (r)"]);
	});

	test("says so when Metro has no terminal", async () => {
		const t = setup(IOS, { metroWrite: () => false });
		await t.actions.run("reload");
		expect(t.row("metro")?.log).toEqual(["reload: Metro is not running"]);
	});
});

describe("show, open, screenshot", () => {
	test("show reveals the sim on iOS and is n/a on Android", async () => {
		const ios = setup(IOS);
		await ios.actions.run("show");
		expect(ios.calls).toEqual(["reveal"]);
		expect(ios.row("action:show")?.status).toBe("ok");
		const android = setup(ANDROID);
		await android.actions.run("show");
		expect(android.calls).toEqual([]);
		expect(android.row("action:show")?.log.join(" ")).toContain("n/a");
		expect(android.row("action:show")?.status).toBe("ok");
	});

	test("open reopens the dev client", async () => {
		const t = setup();
		await t.actions.run("open");
		expect(t.calls).toEqual(["openClient"]);
		expect(t.row("action:open")?.status).toBe("ok");
	});

	test("screenshot logs the saved path in its row", async () => {
		const t = setup();
		await t.actions.run("screenshot");
		expect(t.row("action:screenshot")).toMatchObject({ status: "ok", log: ["/home/dev/l1/shots/001.png"] });
	});

	test("a failed effect fails the row with its message", async () => {
		const t = setup(IOS, { openClient: () => Promise.resolve(fail("no scheme")) });
		await t.actions.run("open");
		expect(t.row("action:open")).toMatchObject({ status: "fail", log: ["no scheme"] });
	});

	test("an effect that throws fails the row instead of the key handler", async () => {
		const t = setup(IOS, {
			screenshot: () => {
				throw new Error("helper gone");
			},
		});
		await t.actions.run("screenshot");
		expect(t.row("action:screenshot")).toMatchObject({ status: "fail", log: ["helper gone"] });
	});

	test("before the session is ready the device actions say so", async () => {
		const t = setup(null);
		await t.actions.run("screenshot");
		expect(t.row("action:screenshot")?.status).toBe("fail");
		expect(t.row("action:screenshot")?.log.join(" ")).toContain("not ready");
		expect(t.calls).toEqual([]);
	});
});

describe("reinstall, restart sim, metro --clear", () => {
	test("reinstall reinstalls then reopens the client", async () => {
		const t = setup();
		await t.actions.run("reinstall");
		expect(t.calls).toEqual(["reinstall", "openClient"]);
		expect(t.row("action:reinstall")?.status).toBe("ok");
	});

	test("a failed reinstall does not reopen the client", async () => {
		const t = setup(IOS, { reinstall: () => Promise.resolve(fail("build failed")) });
		await t.actions.run("reinstall");
		expect(t.calls).toEqual([]);
		expect(t.row("action:reinstall")).toMatchObject({ status: "fail" });
	});

	test("restart sim restarts then reopens the client (iOS)", async () => {
		const t = setup();
		await t.actions.run("restart-sim");
		expect(t.calls).toEqual(["restartSim", "openClient"]);
	});

	test("restart sim is iOS only", async () => {
		const t = setup(ANDROID);
		await t.actions.run("restart-sim");
		expect(t.calls).toEqual([]);
		expect(t.row("action:restart-sim")?.status).toBe("fail");
	});

	test("metro --clear restarts Metro and logs its URL", async () => {
		const t = setup();
		await t.actions.run("metro-clear");
		expect(t.calls).toEqual(["restartMetro"]);
		expect(t.row("action:metro-clear")).toMatchObject({ status: "ok", log: ["http://127.0.0.1:8101"] });
	});

	test("a second reinstall while one runs is refused", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const t = setup(IOS, {
			reinstall: async () => {
				await gate;
				return ok({ source: "cache", hash: "abc" });
			},
		});
		const first = t.actions.run("reinstall");
		await t.actions.run("restart-sim");
		expect(t.row("action:restart-sim")?.log.join(" ")).toContain("busy");
		expect(t.calls).toEqual([]);
		release();
		await first;
		expect(t.calls).toEqual(["openClient"]);
	});
});

describe("device logs", () => {
	test("l streams into a row; l again stops it", async () => {
		let onLine: (line: string) => void = () => undefined;
		const t = setup(IOS, {
			streamLogs: (_i, cb) => {
				onLine = cb;
				return { stop: () => t.calls.push("logs stop"), done: new Promise<string | undefined>(() => undefined) };
			},
		});
		await t.actions.run("logs");
		expect(t.row("action:logs")?.status).toBe("running");
		onLine("one");
		onLine("two");
		t.tick();
		expect(t.row("action:logs")?.log).toEqual(["one\ntwo"]);
		await t.actions.run("logs");
		expect(t.calls).toContain("logs stop");
		expect(t.row("action:logs")?.status).toBe("ok");
		expect(t.liveTickers()).toBe(0);
	});

	test("a stream that ends by itself fails the row with its reason", async () => {
		let end: (reason: string | undefined) => void = () => undefined;
		const t = setup(IOS, {
			streamLogs: () => ({
				stop: () => undefined,
				done: new Promise<string | undefined>((resolve) => {
					end = resolve;
				}),
			}),
		});
		await t.actions.run("logs");
		end("log stream ended (exit 1)");
		await Bun.sleep(0);
		expect(t.row("action:logs")).toMatchObject({ status: "fail" });
		expect(t.row("action:logs")?.log).toContain("log stream ended (exit 1)");
		expect(t.liveTickers()).toBe(0);
	});
});

describe("perf", () => {
	test("p starts a session: HUD state, row title and lines", async () => {
		const t = setup();
		await t.actions.run("perf");
		expect(t.calls).toEqual(["perfStart default"]);
		expect(t.hud()).toEqual({ startedAt: 10_000, marks: 0 });
		const row = t.row("action:perf");
		expect(row?.status).toBe("running");
		expect(row?.log.join("\n")).toContain("perf-1");
		expect(row?.log.join("\n")).toContain("armed: metrics, logs");
		expect(row?.log.join("\n")).toContain("5m00s");
	});

	test("P starts with every collector", async () => {
		const t = setup();
		await t.actions.run("perf-all");
		expect(t.calls).toEqual(["perfStart all"]);
	});

	test("the title counts down to the cap and the session ends there", async () => {
		const t = setup();
		await t.actions.run("perf");
		t.advance(60_000);
		t.tick();
		expect(t.row("action:perf")?.title).toBe("perf ● 4m00s left");
		t.advance(240_000);
		t.tick();
		expect(t.row("action:perf")?.status).toBe("ok");
		expect(t.hud()).toBeUndefined();
		expect(t.liveTickers()).toBe(0);
	});

	test("p again stops the session and shows the report path", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.run("perf");
		expect(t.calls).toEqual(["perfStart default", "perfStop perf-1"]);
		const row = t.row("action:perf");
		expect(row?.status).toBe("ok");
		expect(row?.log).toContain("/home/perf/perf-1/report.md");
		expect(row?.log).toContain("cpu 12%");
		expect(t.hud()).toBeUndefined();
		expect(t.liveTickers()).toBe(0);
	});

	test("P while recording points at p", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.run("perf-all");
		expect(t.calls).toEqual(["perfStart default"]);
		expect(t.row("action:perf")?.log.join("\n")).toContain("p stops it");
	});

	test("session_active explains and records nothing", async () => {
		const t = setup(IOS, {
			perfStart: () => Promise.resolve(fail("perf session perf-0 is already running on UDID-1", "session_active")),
		});
		await t.actions.run("perf");
		expect(t.row("action:perf")?.status).toBe("fail");
		expect(t.row("action:perf")?.log.join("\n")).toContain("one perf session per device");
		expect(t.hud()).toBeUndefined();
		await t.actions.run("mark");
		expect(t.row("action:mark")?.status).toBe("fail");
	});

	test("a session someone else stopped clears local state when p stops it", async () => {
		const t = setup(IOS, {
			perfStop: () => Promise.resolve(fail("no running perf session", "session_not_found")),
		});
		await t.actions.run("perf");
		await t.actions.run("perf");
		expect(t.row("action:perf")?.status).toBe("fail");
		expect(t.hud()).toBeUndefined();
		await t.actions.run("perf");
		expect(t.calls.filter((c) => c.startsWith("perfStart"))).toHaveLength(2);
	});

	test("R and x are disabled while a session records, and say why", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.run("reinstall");
		await t.actions.run("restart-sim");
		expect(t.calls).toEqual(["perfStart default"]);
		for (const id of ["action:reinstall", "action:restart-sim"]) {
			expect(t.row(id)?.status).toBe("fail");
			expect(t.row(id)?.log.join(" ")).toContain("perf session records");
		}
	});

	test("g while recording says to stop first; after stop it renders the report", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.run("report");
		expect(t.row("action:report")?.status).toBe("fail");
		expect(t.calls).toEqual(["perfStart default"]);
		await t.actions.run("perf");
		await t.actions.run("report");
		expect(t.calls.at(-1)).toBe("report");
		expect(t.row("action:report")?.status).toBe("ok");
	});
});

describe("mark", () => {
	test("m without a session logs why and asks nothing", async () => {
		const t = setup();
		await t.actions.run("mark");
		expect(t.events).not.toContain("prompt mark");
		expect(t.row("action:mark")?.status).toBe("fail");
		expect(t.row("action:mark")?.log.join(" ")).toContain("p starts one");
	});

	test("m opens the prompt; submitting records the mark and bumps the HUD count", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.run("mark");
		expect(t.events).toContain("prompt mark");
		await t.actions.submitMark("scroll feed");
		expect(t.calls.at(-1)).toBe("perfMark scroll feed");
		expect(t.hud()).toEqual({ startedAt: 10_000, marks: 1 });
		expect(t.row("action:mark")?.status).toBe("ok");
	});

	test("an empty label records nothing", async () => {
		const t = setup();
		await t.actions.run("perf");
		await t.actions.submitMark("   ");
		expect(t.calls).toEqual(["perfStart default"]);
	});
});

describe("frames and report", () => {
	test("f on iOS explains and skips the effect", async () => {
		const t = setup(IOS);
		await t.actions.run("frames");
		expect(t.calls).toEqual([]);
		expect(t.row("action:frames")?.status).toBe("ok");
		expect(t.row("action:frames")?.log.join(" ")).toContain("no frame API");
	});

	test("f on Android reads frames", async () => {
		const t = setup(ANDROID);
		await t.actions.run("frames");
		expect(t.calls).toEqual(["frames"]);
		expect(t.row("action:frames")?.status).toBe("ok");
	});

	test("g renders the latest report", async () => {
		const t = setup();
		await t.actions.run("report");
		expect(t.calls).toEqual(["report"]);
		expect(t.row("action:report")?.status).toBe("ok");
	});
});

describe("dispose", () => {
	test("stops the log stream and the perf ticker", async () => {
		const t = setup();
		await t.actions.run("logs");
		await t.actions.run("perf");
		t.actions.dispose();
		expect(t.calls).toContain("logs stop");
		expect(t.liveTickers()).toBe(0);
	});
});
