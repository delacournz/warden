import { describe, expect, test } from "bun:test";
import { err, ok } from "@delacour/warden-types/result";
import { type WarmConnect, type WarmHelper, type WarmRun, warmDrivers } from "./warm-drivers";

const devices = [
	{ worker: 0, udid: "U0" },
	{ worker: 1, udid: "U1" },
];

type Fixture = {
	run: WarmRun;
	files: Map<string, string>;
	timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
	warnings: string[];
};

/** the snapshot retry waits (2 s after the first failure, 5 s after later ones): fired at once when `autoRetry` is set */
const RETRY_WAITS_MS: readonly number[] = [2_000, 5_000];

function fixture(signal?: AbortSignal, o: { autoRetry?: boolean } = {}): Fixture {
	const files = new Map<string, string>();
	const timers: Fixture["timers"] = [];
	let clock = 1_000;
	const run: WarmRun = {
		devices,
		logDir: "/logs",
		now: () => clock,
		after: (ms, fn) => {
			const timer = { ms, fire: fn, cancelled: false };
			timers.push(timer);
			if (o.autoRetry && RETRY_WAITS_MS.includes(ms)) {
				queueMicrotask(() => {
					if (timer.cancelled) return;
					clock += ms;
					fn();
				});
			}
			return () => {
				timer.cancelled = true;
			};
		},
		writeFile: async (path, data) => {
			files.set(path, data);
		},
		...(signal ? { signal } : {}),
	};
	return { run, files, timers, warnings: [] };
}

type Fake = { helper: WarmHelper; closed: () => boolean; stopped: () => boolean; snapshots: () => number };

function fake(
	udid: string,
	snapshot: () => ReturnType<WarmHelper["snapshot"]> = async () => ok(null),
	o: { stoppable?: boolean } = {}
): Fake {
	let closed = false;
	let stopped = false;
	let snapshots = 0;
	return {
		helper: {
			socketPath: `/s/${udid}.sock`,
			snapshot: () => {
				snapshots++;
				return snapshot();
			},
			close: async () => {
				closed = true;
			},
			...(o.stoppable
				? {
						stop: async () => {
							stopped = true;
						},
					}
				: {}),
		},
		closed: () => closed,
		stopped: () => stopped,
		snapshots: () => snapshots,
	};
}

describe("warmDrivers", () => {
	test("connects and snapshots every device, logs per worker, returns the sockets", async () => {
		const f = fixture();
		const made = new Map<string, Fake>();
		const connect: WarmConnect = async (udid) => {
			const one = fake(udid);
			made.set(udid, one);
			return ok(one.helper);
		};
		const out = await warmDrivers(f.run, { connect, warn: (l) => f.warnings.push(l) });
		expect(out.devices.map((d) => [d.udid, d.ok, d.socketPath])).toEqual([
			["U0", true, "/s/U0.sock"],
			["U1", true, "/s/U1.sock"],
		]);
		expect([...made.values()].map((m) => m.snapshots())).toEqual([1, 1]);
		expect(out.helpers).toHaveLength(2);
		expect(f.warnings).toEqual([]);
		expect(f.files.get("/logs/warm-0.log")).toContain("snapshot ok");
		expect(f.files.get("/logs/warm-1.log")).toContain("connected /s/U1.sock");
		expect(f.timers.every((t) => t.cancelled && t.ms === 120_000)).toBe(true);
	});

	test("devices warm strictly in order: the next connects only after the previous settled", async () => {
		const f = fixture();
		const order: string[] = [];
		const connect: WarmConnect = async (udid) => {
			order.push(`start ${udid}`);
			await Bun.sleep(1);
			order.push(`end ${udid}`);
			return ok(fake(udid).helper);
		};
		const settled: string[] = [];
		await warmDrivers(f.run, { connect, onDevice: (d) => settled.push(`settled ${d.udid}`) });
		expect(order).toEqual(["start U0", "end U0", "start U1", "end U1"]);
		expect(settled).toEqual(["settled U0", "settled U1"]);
	});

	test("a device that ran out of budget does not hold the next one back", async () => {
		const f = fixture(undefined, { autoRetry: true });
		const bad = fake("U0", async () => err("E_TIMEOUT"), { stoppable: true });
		const good = fake("U1");
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? bad.helper : good.helper);
		const out = await warmDrivers(f.run, { connect, timeoutMs: 8_000 });
		expect(out.devices.map((d) => d.ok)).toEqual([false, true]);
		expect(good.snapshots()).toBe(1);
	});

	test("retries the snapshot with backoff: two failures then success keeps the helper warm", async () => {
		const f = fixture(undefined, { autoRetry: true });
		let n = 0;
		const one = fake(
			"U0",
			async () => {
				n++;
				return n < 3 ? err("E_TIMEOUT") : ok(null);
			},
			{ stoppable: true }
		);
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const out = await warmDrivers(f.run, { connect, warn: (l) => f.warnings.push(l) });
		expect(out.devices[0]).toMatchObject({ ok: true, socketPath: "/s/U0.sock" });
		expect(one.snapshots()).toBe(3);
		expect(one.stopped()).toBe(false);
		expect(one.closed()).toBe(false);
		expect(out.helpers).toContain(one.helper);
		expect(f.warnings).toEqual([]);
		const waits = f.timers.filter((t) => RETRY_WAITS_MS.includes(t.ms)).map((t) => t.ms);
		expect(waits).toEqual([2_000, 5_000]);
		const log = f.files.get("/logs/warm-0.log") ?? "";
		expect(log).toContain("snapshot try 1 failed: E_TIMEOUT; retrying");
		expect(log).toContain("snapshot try 2 failed: E_TIMEOUT; retrying");
		expect(log).toContain("snapshot ok");
	});

	test("the budget running out leaves the device cold: helper stopped, last error reported", async () => {
		const f = fixture(undefined, { autoRetry: true });
		let n = 0;
		const one = fake(
			"U0",
			async () => {
				n++;
				return err(`E_TIMEOUT ${n}`);
			},
			{ stoppable: true }
		);
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const out = await warmDrivers(f.run, { connect, timeoutMs: 10_000, warn: (l) => f.warnings.push(l) });
		expect(one.snapshots()).toBe(3);
		expect(out.devices[0]).toMatchObject({ ok: false, error: `snapshot failed: E_TIMEOUT 3` });
		expect(one.stopped()).toBe(true);
		expect(f.warnings[0]).toContain("snapshot failed: E_TIMEOUT 3");
		expect(f.files.get("/logs/warm-0.log")).toContain("stopped the helper");
		expect(out.helpers.every((h) => h !== one.helper)).toBe(true);
	});

	test("an interrupt during the retry wait stops the retries and only disconnects the helper", async () => {
		const controller = new AbortController();
		const f = fixture(controller.signal);
		const one = fake("U0", async () => err("E_TIMEOUT"), { stoppable: true });
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const running = warmDrivers(f.run, { connect });
		await Bun.sleep(1);
		expect(one.snapshots()).toBe(1);
		const wait = f.timers.find((t) => !t.cancelled && t.ms === 2_000);
		expect(wait).toBeDefined();
		controller.abort();
		const out = await running;
		await Bun.sleep(1);
		expect(out.devices.map((d) => d.error)).toEqual(["interrupted", "interrupted"]);
		expect(one.snapshots()).toBe(1);
		expect(wait?.cancelled).toBe(true);
		expect(one.closed()).toBe(true);
		expect(one.stopped()).toBe(false);
	});

	test("the outer timeout firing during a retry wait stops the retries and stops the helper", async () => {
		const f = fixture();
		const one = fake("U0", async () => err("E_TIMEOUT"), { stoppable: true });
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const running = warmDrivers(f.run, { connect, timeoutMs: 9_000 });
		await Bun.sleep(1);
		f.timers.find((t) => !t.cancelled && t.ms === 9_000)?.fire();
		const out = await running;
		await Bun.sleep(1);
		expect(out.devices[0]).toMatchObject({ ok: false, error: "timed out after 9s" });
		expect(one.snapshots()).toBe(1);
		expect(one.stopped()).toBe(true);
	});

	test("a failed connect only warns and leaves that device cold", async () => {
		const f = fixture();
		const connect: WarmConnect = async (udid) => (udid === "U0" ? err("no helper binary") : ok(fake(udid).helper));
		const out = await warmDrivers(f.run, { connect, warn: (l) => f.warnings.push(l) });
		expect(out.devices.map((d) => d.ok)).toEqual([false, true]);
		expect(out.devices[0]?.error).toBe("no helper binary");
		expect(out.helpers).toHaveLength(1);
		expect(f.warnings).toHaveLength(1);
		expect(f.warnings[0]).toContain("warm U0: no helper binary");
		expect(f.files.get("/logs/warm-0.log")).toContain("not warm: no helper binary");
	});

	test("a throwing connect is a failure, not an exception", async () => {
		const f = fixture();
		const connect: WarmConnect = async () => {
			throw new Error("spawn ENOENT");
		};
		const out = await warmDrivers(f.run, { connect });
		expect(out.devices.every((d) => !d.ok && d.error === "spawn ENOENT")).toBe(true);
	});

	test("a helper that cannot snapshot is closed and the device stays cold", async () => {
		const f = fixture();
		const one = fake("U0", async () => err("AX denied"));
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const out = await warmDrivers(f.run, { connect, timeoutMs: 1_000, warn: (l) => f.warnings.push(l) });
		expect(out.devices[0]).toMatchObject({ ok: false, error: "snapshot failed: AX denied" });
		expect(out.devices[0]?.socketPath).toBeUndefined();
		expect(one.closed()).toBe(true);
		expect(out.helpers).toHaveLength(1);
	});

	test("a helper that cannot snapshot is stopped, not left resident beside the jobs' own helpers (20-1)", async () => {
		const f = fixture();
		const one = fake("U0", async () => err("AX denied"), { stoppable: true });
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const out = await warmDrivers(f.run, { connect, timeoutMs: 1_000, warn: (l) => f.warnings.push(l) });
		expect(out.devices[0]).toMatchObject({ ok: false, error: "snapshot failed: AX denied" });
		expect(one.stopped()).toBe(true);
		expect(f.files.get("/logs/warm-0.log")).toContain("stopped the helper");
	});

	test("a snapshot that throws stops the helper too", async () => {
		const f = fixture();
		const one = fake(
			"U0",
			async () => {
				throw new Error("socket reset");
			},
			{ stoppable: true }
		);
		const out = await warmDrivers(f.run, { connect: async () => ok(one.helper), timeoutMs: 1_000 });
		expect(out.devices[0]).toMatchObject({ ok: false, error: "snapshot failed: socket reset" });
		expect(one.stopped()).toBe(true);
	});

	test("a helper that arrives after the timeout is stopped: its device's jobs already run cold (20-1)", async () => {
		const f = fixture();
		const one = fake("U0", undefined, { stoppable: true });
		let arrive: () => void = () => {};
		const connect: WarmConnect = async (udid) => {
			if (udid !== "U0") return ok(fake(udid).helper);
			await new Promise<void>((resolve) => {
				arrive = resolve;
			});
			return ok(one.helper);
		};
		const running = warmDrivers(f.run, { connect, timeoutMs: 5_000 });
		await Bun.sleep(1);
		f.timers.find((t) => !t.cancelled)?.fire();
		await running;
		arrive();
		await Bun.sleep(1);
		expect(one.stopped()).toBe(true);
	});

	test("a helper that arrives after an interrupt is only disconnected: no job runs, it stays resident", async () => {
		const controller = new AbortController();
		const f = fixture(controller.signal);
		const one = fake("U0", undefined, { stoppable: true });
		let arrive: () => void = () => {};
		const connect: WarmConnect = async (udid) => {
			if (udid !== "U0") return ok(fake(udid).helper);
			await new Promise<void>((resolve) => {
				arrive = resolve;
			});
			return ok(one.helper);
		};
		const running = warmDrivers(f.run, { connect });
		await Bun.sleep(1);
		controller.abort();
		await running;
		arrive();
		await Bun.sleep(1);
		expect(one.closed()).toBe(true);
		expect(one.stopped()).toBe(false);
	});

	test("the timeout leaves the device cold and closes the helper when it finally arrives", async () => {
		const f = fixture();
		const one = fake("U0");
		let arrive: () => void = () => {};
		const connect: WarmConnect = async (udid) => {
			if (udid !== "U0") return ok(fake(udid).helper);
			await new Promise<void>((resolve) => {
				arrive = resolve;
			});
			return ok(one.helper);
		};
		const running = warmDrivers(f.run, { connect, timeoutMs: 5_000, warn: (l) => f.warnings.push(l) });
		await Bun.sleep(1);
		const stuck = f.timers.find((t) => !t.cancelled);
		expect(stuck?.ms).toBe(5_000);
		stuck?.fire();
		const out = await running;
		expect(out.devices[0]).toMatchObject({ ok: false, error: "timed out after 5s" });
		expect(f.warnings[0]).toContain("timed out");
		arrive();
		await Bun.sleep(1);
		expect(one.closed()).toBe(true);
	});

	test("an interrupt stops waiting", async () => {
		const controller = new AbortController();
		const f = fixture(controller.signal);
		const connect: WarmConnect = () => new Promise(() => {});
		const running = warmDrivers(f.run, { connect });
		await Bun.sleep(1);
		controller.abort();
		const out = await running;
		expect(out.devices.map((d) => d.error)).toEqual(["interrupted", "interrupted"]);
	});
});
