import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { AUTO_TIME_OFF_ARGV, AUTO_TIME_ON_ARGV, applyAndroidClock, DATE_ARGV, setTimeArgv } from "./android-clock";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";

const HOST_NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** A device whose wall clock `cmd alarm set-time` moves (unless `stuck`, then only `date -s` as root does). */
function device(opts: { stuck?: boolean; rootable?: boolean; alarmFails?: boolean } = {}) {
	let deviceMs = HOST_NOW;
	let autoTime = 1;
	const rules: ShellRule[] = [
		{
			match: "settings put global auto_time",
			reply: (cmd) => {
				autoTime = Number(cmd.split(" ").pop());
				return "";
			},
		},
		{
			match: "cmd alarm set-time",
			reply: (cmd) => {
				if (opts.alarmFails) return { stdout: "Error: permission denied\n", exitCode: 1 };
				if (!opts.stuck) deviceMs = Number(cmd.split(" ").pop());
				return "true\n";
			},
		},
		{ match: "date +%s", reply: () => `${Math.floor(deviceMs / 1000)}\n` },
		{
			match: "date -s",
			reply: (cmd) => {
				deviceMs = Number(cmd.split("@").pop()) * 1000;
				return "";
			},
		},
	];
	const host = fakeAndroidHost({
		shell: rules,
		host: [
			{
				match: /root$/,
				reply: opts.rootable
					? "restarting adbd as root\n"
					: { stdout: "adbd cannot run as root in production builds\n", exitCode: 1 },
			},
			{ match: /wait-for-device$/, reply: "" },
			{
				match: /date -s/,
				reply: () => {
					deviceMs = HOST_NOW + DAY;
					return "";
				},
			},
		],
	});
	return { host, ms: () => deviceMs, autoTime: () => autoTime };
}

async function run(
	d: ReturnType<typeof device>,
	op: Parameters<typeof applyAndroidClock>[1],
	serial = "emulator-5554"
) {
	const session = openAdbSession({ adb: "adb", serial, spawn: d.host.spawn });
	try {
		return await applyAndroidClock({ session, exec: d.host.exec, adb: "adb", serial, wallNow: () => HOST_NOW }, op);
	} finally {
		await session.close();
	}
}

describe("argv", () => {
	test("auto_time and set-time are device shell argv", () => {
		expect(AUTO_TIME_OFF_ARGV).toEqual(["settings", "put", "global", "auto_time", "0"]);
		expect(AUTO_TIME_ON_ARGV).toEqual(["settings", "put", "global", "auto_time", "1"]);
		expect(setTimeArgv(1_700_000_000_123)).toEqual(["cmd", "alarm", "set-time", "1700000000123"]);
		expect(DATE_ARGV).toEqual(["date", "+%s"]);
	});
});

describe("applyAndroidClock", () => {
	test("offset: auto time off, system time moved and read back", async () => {
		const d = device();
		const result = await run(d, { kind: "offset", ms: 2 * DAY });
		expect(result).toEqual({
			success: true,
			data: { condition: { kind: "offset", ms: 2 * DAY }, offsetMs: 2 * DAY, frozen: false, nowMs: HOST_NOW + 2 * DAY },
		});
		expect(d.autoTime()).toBe(0);
		expect(d.ms()).toBe(HOST_NOW + 2 * DAY);
	});

	test("fixed sets the instant", async () => {
		const d = device();
		const at = new Date(HOST_NOW + 15 * DAY).toISOString();
		const result = await run(d, { kind: "fixed", at });
		expect(result.success && result.data.offsetMs).toBe(15 * DAY);
		expect(d.ms()).toBe(HOST_NOW + 15 * DAY);
	});

	test("real turns auto time back on and sets the host time", async () => {
		const d = device();
		await run(d, { kind: "offset", ms: DAY });
		const result = await run(d, { kind: "real" });
		expect(result.success && result.data).toMatchObject({ offsetMs: 0, frozen: false });
		expect(d.autoTime()).toBe(1);
		expect(d.ms()).toBe(HOST_NOW);
	});

	test("frozen is E_UNSUPPORTED: system time keeps running", async () => {
		const d = device();
		const result = await run(d, { kind: "frozen", at: new Date(HOST_NOW).toISOString() });
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
		expect(d.host.shell).toEqual([]);
	});

	test("a physical device is E_UNSUPPORTED", async () => {
		const d = device();
		const result = await run(d, { kind: "offset", ms: DAY }, "R5CT123ABC");
		expect(!result.success && result.error.code).toBe("E_UNSUPPORTED");
	});

	test("an unreadable instant is E_BAD_REQUEST and touches nothing", async () => {
		const d = device();
		const result = await run(d, { kind: "fixed", at: "tomorrow-ish" });
		expect(!result.success && result.error.code).toBe("E_BAD_REQUEST");
		expect(d.host.shell).toEqual([]);
	});

	test("when set-time does not move the clock and adb cannot root, it fails with E_IO", async () => {
		const d = device({ stuck: true });
		const result = await run(d, { kind: "offset", ms: DAY });
		expect(!result.success && result.error.code).toBe("E_IO");
	});

	test("when set-time does not move the clock, root + date -s is tried", async () => {
		const d = device({ stuck: true, rootable: true });
		const result = await run(d, { kind: "offset", ms: DAY });
		expect(d.host.host.some((c) => c.includes("root"))).toBe(true);
		expect(d.host.host.some((c) => c.includes("date"))).toBe(true);
		expect(result.success && result.data.nowMs).toBe(HOST_NOW + DAY);
	});
});
