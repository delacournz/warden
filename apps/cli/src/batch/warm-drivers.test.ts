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

function fixture(signal?: AbortSignal): Fixture {
	const files = new Map<string, string>();
	const timers: Fixture["timers"] = [];
	const run: WarmRun = {
		devices,
		logDir: "/logs",
		now: () => 1_000,
		after: (ms, fn) => {
			const timer = { ms, fire: fn, cancelled: false };
			timers.push(timer);
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

	test("devices warm in parallel", async () => {
		const f = fixture();
		const order: string[] = [];
		const connect: WarmConnect = async (udid) => {
			order.push(`start ${udid}`);
			await Bun.sleep(1);
			order.push(`end ${udid}`);
			return ok(fake(udid).helper);
		};
		await warmDrivers(f.run, { connect });
		expect(order.slice(0, 2)).toEqual(["start U0", "start U1"]);
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
		const out = await warmDrivers(f.run, { connect, warn: (l) => f.warnings.push(l) });
		expect(out.devices[0]).toMatchObject({ ok: false, error: "snapshot failed: AX denied" });
		expect(out.devices[0]?.socketPath).toBeUndefined();
		expect(one.closed()).toBe(true);
		expect(out.helpers).toHaveLength(1);
	});

	test("a helper that cannot snapshot is stopped, not left resident beside the jobs' own helpers (20-1)", async () => {
		const f = fixture();
		const one = fake("U0", async () => err("AX denied"), { stoppable: true });
		const connect: WarmConnect = async (udid) => ok(udid === "U0" ? one.helper : fake(udid).helper);
		const out = await warmDrivers(f.run, { connect, warn: (l) => f.warnings.push(l) });
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
		const out = await warmDrivers(f.run, { connect: async () => ok(one.helper) });
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
