import { describe, expect, test } from "bun:test";
import type { ClockCondition } from "@delacour/warden-config/conditions.types";
import { BaseDriver, type BaseDriverOptions, type SettleResult } from "./base-driver";
import type { TickerClock } from "./conditions/route-ticker";
import type { ClockState, DriverError, DriverResult, Element, NetworkState, Snapshot } from "./driver.types";

const element = (label: string): Element =>
	({
		role: "button",
		label,
		frame: { x: 0, y: 0, width: 10, height: 10 },
		depth: 0,
		hittable: true,
		enabled: true,
		hidden: false,
		children: [],
	}) as unknown as Element;

const snapshotOf = (...labels: string[]): Snapshot => ({
	platform: "ios",
	backend: "axbridge",
	takenAt: 0,
	screen: { width: 10, height: 10, scale: 1 },
	elements: [],
	flat: labels.map(element),
	truncated: false,
});

const failure = (code: DriverError["code"]): { success: false; error: DriverError } => ({
	success: false,
	error: { code, message: code, retryable: false },
});

/** Virtual flap time: a sleep ends after one macrotask, or at once on abort. */
const flapClock: TickerClock = {
	now: () => 0,
	sleep: (_ms, signal) =>
		new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			setTimeout(resolve, 1);
			signal.addEventListener("abort", () => resolve());
		}),
};

const online = (isOnline: boolean): NetworkState => ({
	online: isOnline,
	needsProxy: [],
	condition: { kind: isOnline ? "online" : "offline" },
});

/** Minimal concrete driver: every hook records its call, and the snapshot source is a function the test sets. */
class Probe extends BaseDriver {
	readonly platform = "android" as const;
	readonly id = "probe";
	readonly calls: string[] = [];
	snapshot: () => DriverResult<Snapshot> = async () => ({ success: true, data: snapshotOf("a") });
	native: SettleResult | undefined;
	clockAnswer: Awaited<DriverResult<ClockState>> | undefined;

	pushSave(promise: Promise<void>): void {
		this.saving.push(promise);
	}

	protected takeSnapshot(): DriverResult<Snapshot> {
		return this.snapshot();
	}

	protected override async nativeSettle(): Promise<SettleResult | undefined> {
		this.calls.push("nativeSettle");
		return this.native;
	}

	protected override async applyNetwork(op: Parameters<BaseDriver["network"]>[0]): DriverResult<NetworkState> {
		this.calls.push(`network:${op.kind}`);
		return { success: true, data: online(op.kind !== "offline") };
	}

	protected override async applyClock(): DriverResult<ClockState> {
		return this.clockAnswer ?? failure("E_INTERNAL");
	}

	protected override async stopHelper(): Promise<void> {
		this.calls.push("stopHelper");
	}

	protected override async restoreSettings(): Promise<void> {
		this.calls.push("restoreSettings");
	}

	protected override async teardown(): Promise<void> {
		this.calls.push("teardown");
	}
}

/** A driver that overrides only the abstract hook: everything else is the base default. */
class Bare extends BaseDriver {
	readonly platform = "ios" as const;
	readonly id = "bare";
	torn = 0;

	protected async takeSnapshot(): DriverResult<Snapshot> {
		return { success: true, data: snapshotOf() };
	}

	protected override async teardown(): Promise<void> {
		this.torn += 1;
	}
}

function rig(extra: Partial<BaseDriverOptions> = {}) {
	const t = { now: 0 };
	const driver = new Probe({
		now: () => t.now,
		sleep: async (ms) => {
			t.now += ms;
		},
		tickerClock: flapClock,
		...extra,
	});
	return { driver, t };
}

const bare = () => new Bare({ now: () => 0, sleep: async () => undefined });

describe("BaseDriver settle", () => {
	test("a native settle that answers wins and no snapshot is read", async () => {
		const { driver } = rig();
		driver.native = { success: true, data: { quiet: true, waitedMs: 7, via: "stream" } };
		driver.snapshot = async () => failure("E_INTERNAL");
		expect((await driver.settle({ quietMs: 100 })) as unknown).toEqual({
			success: true,
			data: { quiet: true, waitedMs: 7, via: "stream" },
		});
	});

	test("with no native answer it polls snapshot hashes and says via hash", async () => {
		const { driver, t } = rig();
		const res = await driver.settle({ quietMs: 100, timeoutMs: 1000 });
		expect(driver.calls).toEqual(["nativeSettle"]);
		expect(res as unknown).toEqual({ success: true, data: { quiet: true, waitedMs: t.now, via: "hash" } });
	});

	test("a screen that keeps changing is not quiet at the timeout", async () => {
		const { driver } = rig();
		let n = 0;
		driver.snapshot = async () => ({ success: true, data: snapshotOf(`s${n++}`) });
		const res = await driver.settle({ quietMs: 100, timeoutMs: 500 });
		expect(res.success && res.data.quiet).toBe(false);
	});

	test("a failed snapshot while polling is the settle failure", async () => {
		const { driver } = rig();
		driver.snapshot = async () => failure("E_AX_UNAVAILABLE");
		expect(await driver.settle()).toEqual(failure("E_AX_UNAVAILABLE"));
	});

	test("defaults come from the base options", async () => {
		const { driver, t } = rig({ settleDefaults: { quietMs: 40, timeoutMs: 400 } });
		let n = 0;
		driver.snapshot = async () => ({ success: true, data: snapshotOf(`s${n++}`) });
		await driver.settle();
		expect(t.now).toBeGreaterThanOrEqual(400);
		expect(t.now).toBeLessThan(500);
	});
});

describe("BaseDriver network", () => {
	test("a plain condition goes straight to applyNetwork", async () => {
		const { driver } = rig();
		expect(await driver.network({ kind: "offline" })).toEqual({ success: true, data: online(false) });
		expect(driver.calls).toEqual(["network:offline"]);
	});

	test("a flap base cannot be a flap, and both phases need a length", async () => {
		const { driver } = rig();
		const nested = await driver.network({
			kind: "flap",
			upMs: 10,
			downMs: 10,
			base: { kind: "flap", upMs: 1, downMs: 1 },
		});
		expect(!nested.success && nested.error.code).toBe("E_BAD_REQUEST");
		const zero = await driver.network({ kind: "flap", upMs: 0, downMs: 10 });
		expect(!zero.success && zero.error.code).toBe("E_BAD_REQUEST");
		expect(driver.calls).toEqual([]);
	});

	test("a flap applies its base, reports the condition, alternates, and the next op stops it", async () => {
		const { driver } = rig();
		const flap = { kind: "flap", upMs: 5, downMs: 5 } as const;
		expect(await driver.network(flap)).toEqual({ success: true, data: { ...online(true), condition: flap } });
		for (let i = 0; i < 200 && driver.calls.length < 4; i++) await Bun.sleep(2);
		expect(driver.calls.slice(0, 3)).toEqual(["network:online", "network:offline", "network:online"]);
		await driver.network({ kind: "offline" });
		const settled = driver.calls.length;
		await Bun.sleep(20);
		expect(driver.calls).toHaveLength(settled);
	});
});

describe("BaseDriver unsupported defaults", () => {
	test("network, clock and location answer E_UNSUPPORTED until a subclass overrides them", async () => {
		const driver = bare();
		const net = await driver.network({ kind: "offline" });
		expect(!net.success && net.error.code).toBe("E_UNSUPPORTED");
		const clock = await driver.clock({ kind: "real" });
		expect(!clock.success && clock.error.code).toBe("E_UNSUPPORTED");
		const loc = await driver.location({ kind: "point", lat: 1, lon: 2 });
		expect(!loc.success && loc.error.code).toBe("E_UNSUPPORTED");
	});

	test("clearing a location needs no hook", async () => {
		expect(await bare().location({ kind: "clear" })).toEqual({ success: true, data: undefined });
	});
});

describe("BaseDriver clock", () => {
	test("the recorder hears only the clock ops that succeeded", async () => {
		const heard: ClockCondition[] = [];
		const { driver } = rig({ clockRecorder: (op) => heard.push(op) });
		const op: ClockCondition = { kind: "real" };
		driver.clockAnswer = { success: true, data: {} as ClockState };
		await driver.clock(op);
		driver.clockAnswer = failure("E_IO");
		await driver.clock(op);
		expect(heard).toEqual([op]);
	});
});

describe("BaseDriver close", () => {
	test("stops the flap, then the helper, restores settings, flushes saves, and tears down last", async () => {
		const { driver } = rig();
		await driver.network({ kind: "flap", upMs: 5, downMs: 5 });
		driver.pushSave(Bun.sleep(5).then(() => void driver.calls.push("saved")));
		await driver.close();
		expect(driver.calls.slice(driver.calls.indexOf("stopHelper"))).toEqual([
			"stopHelper",
			"restoreSettings",
			"saved",
			"teardown",
		]);
		const after = driver.calls.length;
		await Bun.sleep(20);
		expect(driver.calls).toHaveLength(after);
	});

	test("every hook but takeSnapshot defaults to a no-op", async () => {
		const driver = bare();
		await driver.close();
		expect(driver.torn).toBe(1);
	});
});
