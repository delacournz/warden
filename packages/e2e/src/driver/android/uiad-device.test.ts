import { describe, expect, test } from "bun:test";
import type { SimdSpawn } from "../ios/simd-transport";
import type { AdbRunResult, AdbSession } from "./adb-session";
import { fakeUiad } from "./uiad.testing";
import { isBusy } from "./uiad-client";
import {
	busyError,
	ensureUiadDex,
	HOLDERS_COMMAND,
	launchUiad,
	type PushDex,
	parseHolders,
	uiadBuildId,
	uiadDevicePath,
	uiadInstallArgv,
	uiadInstallCommand,
	uiadLaunchArgv,
	uiadLaunchCommand,
	uiadPresentCommand,
} from "./uiad-device";
import { UIAD_DEX } from "./uiad-dex.generated";

const SERIAL = "emulator-5554";
const PATH = uiadDevicePath();

const BUSY = {
	code: "E_AX_UNAVAILABLE",
	message: "UiAutomationService already registered!",
	retryable: false,
	detail: { reason: "uiautomation_busy" },
};

const PS_OURS = "  812 app_process / nz.co.delacour.warden.uiad.Main";
const PS_MAESTRO =
	" 3120 app_process /system/bin com.android.commands.am.Am instrument -w -e debug false dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner";

type Shell = { commands: string[]; session: AdbSession };

/** A resident shell that answers from rules (first prefix match) and records every command. */
function fakeSession(rules: Array<{ match: string; reply: string | (() => string) }>): Shell {
	const commands: string[] = [];
	const session: AdbSession = {
		async run(cmd) {
			commands.push(cmd);
			const rule = rules.find((r) => cmd.startsWith(r.match));
			const stdout = typeof rule?.reply === "function" ? rule.reply() : (rule?.reply ?? "");
			const result: AdbRunResult = { stdout, exitCode: 0 };
			return { success: true, data: result };
		},
		async close() {},
	};
	return { commands, session };
}

const pushed: Array<{ argv: readonly string[]; bytes: Uint8Array }> = [];
const okPush: PushDex = async (argv, bytes) => {
	pushed.push({ argv, bytes });
	return { exitCode: 0, output: "" };
};

/** Servers in the order they are spawned: the first start gets `first`, the second `second`, and so on. */
function inOrder(...spawns: SimdSpawn[]): { spawn: SimdSpawn; count: () => number } {
	let n = 0;
	return {
		spawn: (cmd) => {
			const spawn = spawns[Math.min(n, spawns.length - 1)];
			n++;
			if (spawn === undefined) throw new Error("no fake spawn");
			return spawn(cmd);
		},
		count: () => n,
	};
}

describe("device commands", () => {
	test("the dex is named after its hash, and the build id is the same eight characters", () => {
		expect(PATH).toBe(`/data/local/tmp/warden-uiad-${UIAD_DEX.dexSha256.slice(0, 8)}.dex`);
		expect(uiadBuildId()).toBe(UIAD_DEX.dexSha256.slice(0, 8));
	});

	test("the server is started by exec, so the pipe is on the server and not on a wrapper shell", () => {
		expect(uiadLaunchCommand(PATH)).toBe(`exec env CLASSPATH=${PATH} app_process / nz.co.delacour.warden.uiad.Main`);
		expect(uiadLaunchArgv("adb", SERIAL, PATH)).toEqual(["adb", "-s", SERIAL, "shell", uiadLaunchCommand(PATH)]);
	});

	test("the dex is written beside its final name and renamed into place, read-only", () => {
		expect(uiadInstallCommand(PATH)).toBe(`cat > ${PATH}.part && chmod 444 ${PATH}.part && mv ${PATH}.part ${PATH}`);
		expect(uiadInstallArgv("adb", SERIAL, PATH).slice(0, 4)).toEqual(["adb", "-s", SERIAL, "shell"]);
	});

	test("the presence check compares the size on the device with the size of the dex", () => {
		const command = uiadPresentCommand(PATH, 26936);
		expect(command).toContain(`[ -f ${PATH} ]`);
		expect(command).toContain("= 26936");
		expect(command.endsWith("echo present")).toBe(true);
	});
});

describe("ensureUiadDex", () => {
	test("a dex that is already on the device is not written again", async () => {
		pushed.length = 0;
		const shell = fakeSession([{ match: "[ -f", reply: "present\n" }]);
		const ensured = await ensureUiadDex({ session: shell.session, adb: "adb", serial: SERIAL, push: okPush });
		expect(ensured).toEqual({ success: true, data: PATH });
		expect(pushed).toEqual([]);
		expect(shell.commands).toEqual([uiadPresentCommand(PATH, UIAD_DEX.bytes)]);
	});

	test("a missing dex is written through adb's stdin: exactly the bytes the module carries", async () => {
		pushed.length = 0;
		const shell = fakeSession([{ match: "[ -f", reply: "" }]);
		const ensured = await ensureUiadDex({ session: shell.session, adb: "adb", serial: SERIAL, push: okPush });
		expect(ensured).toEqual({ success: true, data: PATH });
		expect(pushed).toHaveLength(1);
		expect(pushed[0]?.argv).toEqual(uiadInstallArgv("adb", SERIAL, PATH));
		expect(Buffer.from(pushed[0]?.bytes ?? []).toString("base64")).toBe(UIAD_DEX.base64);
	});

	test("a write that fails is an E_IO that says where", async () => {
		const shell = fakeSession([]);
		const ensured = await ensureUiadDex({
			session: shell.session,
			adb: "adb",
			serial: SERIAL,
			push: async () => ({ exitCode: 1, output: "adb: error: closed" }),
		});
		expect(ensured.success).toBe(false);
		if (ensured.success) return;
		expect(ensured.error.code).toBe("E_IO");
		expect(ensured.error.message).toContain(PATH);
		expect(ensured.error.message).toContain("closed");
	});
});

describe("parseHolders", () => {
	test("our server is ours; an instrumentation run is not; the `ps` that lists them is neither", () => {
		const holders = parseHolders(
			[
				"  PID ARGS",
				"    1 init",
				PS_OURS,
				PS_MAESTRO,
				" 4001 ps -A -o PID,ARGS",
				" 4002 /system/bin/uiautomator dump /dev/tty",
				" 5000 com.google.android.gms.persistent",
			].join("\n")
		);
		expect(holders).toEqual([
			{ pid: 812, args: "app_process / nz.co.delacour.warden.uiad.Main", ours: true },
			{ pid: 3120, args: PS_MAESTRO.trim().replace(/^3120 /, ""), ours: false },
			{ pid: 4002, args: "/system/bin/uiautomator dump /dev/tty", ours: false },
		]);
	});

	test("nothing listed, nothing held", () => {
		expect(parseHolders("")).toEqual([]);
		expect(parseHolders("  PID ARGS\n    1 init\n")).toEqual([]);
	});
});

describe("busyError", () => {
	test("names every holder, says warden will not touch it, and is a busy error the callers can recognise", () => {
		const error = busyError(SERIAL, parseHolders(PS_MAESTRO), {
			code: "E_AX_UNAVAILABLE",
			message: "x",
			retryable: false,
		});
		expect(isBusy(error)).toBe(true);
		expect(error.retryable).toBe(false);
		expect(error.message).toContain(SERIAL);
		expect(error.message).toContain("pid 3120");
		expect(error.message).toContain("maestro");
		expect(error.message).toContain("will not touch");
	});

	test("no holder found is still an answer", () => {
		const error = busyError(SERIAL, [], { code: "E_AX_UNAVAILABLE", message: "x", retryable: false });
		expect(error.message).toContain("an unknown process");
	});
});

describe("launchUiad", () => {
	const present = { match: "[ -f", reply: "present\n" };

	test("starts the server on the device's dex and hands back the connection", async () => {
		const fake = fakeUiad();
		const shell = fakeSession([present]);
		const launched = await launchUiad({ session: shell.session, adb: "adb", serial: SERIAL, spawn: fake.spawn });
		if (!launched.success) throw new Error(launched.error.message);
		expect(fake.commands).toEqual([uiadLaunchArgv("adb", SERIAL, PATH)]);
		expect(shell.commands).toEqual([uiadPresentCommand(PATH, UIAD_DEX.bytes)]);
		await launched.data.close();
	});

	test("a dex that cannot be written stops before anything is spawned", async () => {
		const fake = fakeUiad();
		const launched = await launchUiad({
			session: fakeSession([]).session,
			adb: "adb",
			serial: SERIAL,
			spawn: fake.spawn,
			push: async () => ({ exitCode: 1, output: "no space left" }),
		});
		expect(launched.success).toBe(false);
		expect(fake.started()).toBe(0);
	});

	test("a stale server of ours holding the slot is killed, by pid, and the start tried once more", async () => {
		const busy = fakeUiad({ fatal: BUSY });
		const good = fakeUiad();
		const order = inOrder(busy.spawn, good.spawn);
		const shell = fakeSession([present, { match: HOLDERS_COMMAND, reply: `PID ARGS\n${PS_OURS}\n` }]);
		const slept: number[] = [];
		const launched = await launchUiad({
			session: shell.session,
			adb: "adb",
			serial: SERIAL,
			spawn: order.spawn,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		if (!launched.success) throw new Error(launched.error.message);
		expect(order.count()).toBe(2);
		expect(shell.commands).toContain("kill 812");
		expect(slept).toHaveLength(1);
		await launched.data.close();
	});

	test("anything else holding the slot is named and left alone, with no second try", async () => {
		const busy = fakeUiad({ fatal: BUSY });
		const order = inOrder(busy.spawn);
		const shell = fakeSession([present, { match: HOLDERS_COMMAND, reply: `PID ARGS\n${PS_MAESTRO}\n` }]);
		const launched = await launchUiad({ session: shell.session, adb: "adb", serial: SERIAL, spawn: order.spawn });
		expect(launched.success).toBe(false);
		if (launched.success) return;
		expect(isBusy(launched.error)).toBe(true);
		expect(launched.error.message).toContain("pid 3120");
		expect(order.count()).toBe(1);
		expect(shell.commands.some((c) => c.startsWith("kill"))).toBe(false);
	});

	test("our stale server next to a foreign client: nothing is killed, because the foreign one would still hold the slot", async () => {
		const busy = fakeUiad({ fatal: BUSY });
		const shell = fakeSession([present, { match: HOLDERS_COMMAND, reply: `${PS_OURS}\n${PS_MAESTRO}\n` }]);
		const launched = await launchUiad({
			session: shell.session,
			adb: "adb",
			serial: SERIAL,
			spawn: busy.spawn,
		});
		expect(launched.success).toBe(false);
		expect(shell.commands.some((c) => c.startsWith("kill"))).toBe(false);
	});

	test("still busy after the kill is reported with whoever holds it now", async () => {
		const busy = fakeUiad({ fatal: BUSY });
		const holders = [`${PS_OURS}\n`, `${PS_MAESTRO}\n`];
		const shell = fakeSession([present, { match: HOLDERS_COMMAND, reply: () => holders.shift() ?? "" }]);
		const launched = await launchUiad({
			session: shell.session,
			adb: "adb",
			serial: SERIAL,
			spawn: busy.spawn,
			sleep: async () => undefined,
		});
		expect(launched.success).toBe(false);
		if (launched.success) return;
		expect(isBusy(launched.error)).toBe(true);
		expect(launched.error.message).toContain("pid 3120");
		expect(busy.started()).toBe(2);
	});

	test("a busy slot with nothing recognisable in `ps` is refused, not retried blindly", async () => {
		const busy = fakeUiad({ fatal: BUSY });
		const shell = fakeSession([present, { match: HOLDERS_COMMAND, reply: "PID ARGS\n    1 init\n" }]);
		const launched = await launchUiad({ session: shell.session, adb: "adb", serial: SERIAL, spawn: busy.spawn });
		expect(launched.success).toBe(false);
		if (launched.success) return;
		expect(launched.error.message).toContain("an unknown process");
		expect(busy.started()).toBe(1);
	});

	test("other start failures are passed through untouched (a crash is not a busy slot)", async () => {
		const crash = fakeUiad({ exitBeforeReady: 1, stderr: ["boom"] });
		const shell = fakeSession([present]);
		const launched = await launchUiad({ session: shell.session, adb: "adb", serial: SERIAL, spawn: crash.spawn });
		expect(launched.success).toBe(false);
		if (launched.success) return;
		expect(launched.error.code).toBe("E_HELPER_CRASHED");
		expect(shell.commands).toEqual([uiadPresentCommand(PATH, UIAD_DEX.bytes)]);
	});
});
