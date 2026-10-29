import { afterEach, describe, expect, test } from "bun:test";
import type { ConditionEvent } from "../../conditions/condition-events";
import type { TickerClock } from "../../conditions/route-ticker";
import type { Driver } from "../driver.types";
import { openAndroidDriver } from "./android-driver";
import { fakeAndroidHost } from "./android-host.testing";
import { DUMPSYS_AIRPLANE, DUMPSYS_ONLINE } from "./network.fixture";

const open: Driver[] = [];

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

async function setup(conditionSink?: (e: ConditionEvent) => void) {
	let airplane = false;
	const fake = fakeAndroidHost({
		shell: [
			{ match: "getprop sys.boot_completed", reply: "1\n34\nPhysical size: 1080x2400\nPhysical density: 420\n" },
			{
				match: "cmd connectivity airplane-mode",
				reply: (cmd) => {
					airplane = cmd.endsWith("enable");
					return "";
				},
			},
			{ match: "dumpsys connectivity", reply: () => (airplane ? DUMPSYS_AIRPLANE : DUMPSYS_ONLINE) },
		],
		host: [{ match: /emu network/, reply: "OK\n" }],
	});
	let t = 0;
	const res = await openAndroidDriver({
		serial: "emulator-5554",
		adb: "adb",
		exec: fake.exec,
		spawn: fake.spawn,
		execBinary: fake.execBinary,
		clock: {
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
		},
		screen: { width: 1080, height: 2400, scale: 2.625 },
		tickerClock: flapClock,
		...(conditionSink ? { conditionSink } : {}),
	});
	if (!res.success) throw new Error(res.error.message);
	open.push(res.data);
	const airplaneCalls = () =>
		fake.shell.filter((c) => c.startsWith("cmd connectivity airplane-mode")).map((c) => c.split(" ").at(-1));
	return { driver: res.data, airplaneCalls };
}

const FLAP = { kind: "flap", upMs: 50, downMs: 50 } as const;

afterEach(async () => {
	await Promise.all(open.splice(0).map((d) => d.close()));
});

describe("android network flap", () => {
	test("starts online, reports the flap, then alternates offline/online in this process", async () => {
		const events: ConditionEvent[] = [];
		const { driver, airplaneCalls } = await setup((e) => events.push(e));
		const res = await driver.network(FLAP);
		expect(res).toEqual({ success: true, data: { online: true, condition: FLAP, needsProxy: [] } });
		for (let i = 0; i < 200 && events.length < 3; i++) await Bun.sleep(5);
		expect(events.length).toBeGreaterThanOrEqual(3);
		expect(events.slice(0, 3).map((e) => e.value.kind)).toEqual(["offline", "online", "offline"]);
		expect(airplaneCalls().slice(0, 3)).toEqual(["disable", "enable", "disable"]);
	});

	test("the next network op stops the flap and nothing flaps after it", async () => {
		const { driver, airplaneCalls } = await setup();
		await driver.network(FLAP);
		await Bun.sleep(30);
		const res = await driver.network({ kind: "offline" });
		expect(res.success && res.data.online).toBe(false);
		const settled = airplaneCalls().length;
		await Bun.sleep(40);
		expect(airplaneCalls()).toHaveLength(settled);
		expect(airplaneCalls().at(-1)).toBe("enable");
	});

	test("close ends the flap with the base back", async () => {
		const { driver, airplaneCalls } = await setup();
		await driver.network(FLAP);
		await Bun.sleep(30);
		await driver.close();
		open.pop();
		expect(airplaneCalls().at(-1)).toBe("disable");
	});

	test("bad flap options are E_BAD_REQUEST and nothing is applied", async () => {
		const { driver, airplaneCalls } = await setup();
		const zero = await driver.network({ kind: "flap", upMs: 0, downMs: 5 });
		expect(!zero.success && zero.error.code).toBe("E_BAD_REQUEST");
		const nested = await driver.network({
			kind: "flap",
			upMs: 5,
			downMs: 5,
			base: { kind: "flap", upMs: 1, downMs: 1 },
		});
		expect(!nested.success && nested.error.code).toBe("E_BAD_REQUEST");
		expect(airplaneCalls()).toEqual([]);
	});
});
