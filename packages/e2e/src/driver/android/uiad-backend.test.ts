import { afterEach, describe, expect, test } from "bun:test";
import type { DriverError, DriverResult } from "../driver.types";
import { driverError } from "../errors";
import type { AdbSession } from "./adb-session";
import { fakeUiad } from "./uiad.testing";
import { createUiadBackend, isPersistentStartFailure, type UiadBackendDeps, uiadFromEnv } from "./uiad-backend";
import { startUiad, type UiadClient } from "./uiad-client";
import { launchUiad, uiadBuildId } from "./uiad-device";

const SESSION: AdbSession = {
	async run() {
		return { success: true, data: { stdout: "", exitCode: 0 } };
	},
	async close() {},
};

const BUSY = driverError("E_AX_UNAVAILABLE", "another UiAutomation client holds emulator-5554", {
	retryable: false,
	detail: { reason: "uiautomation_busy" },
});

function fakeClock() {
	let t = 1_000;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

type Launch = NonNullable<UiadBackendDeps["launch"]>;

/** A launcher that connects to `fake` (a real client over the in-process server), counting starts. */
function connecting(fake: ReturnType<typeof fakeUiad>): { launch: Launch; starts: () => number } {
	let starts = 0;
	return {
		launch: async () => {
			starts++;
			return startUiad({ cmd: ["adb", "shell", "x"], spawn: fake.spawn, graceMs: 20 });
		},
		starts: () => starts,
	};
}

/** A launcher whose starts answer from `results` in order (the last repeats). */
function scripted(...results: Array<DriverError | "ok">): {
	launch: Launch;
	starts: () => number;
	fake: ReturnType<typeof fakeUiad>;
} {
	const fake = fakeUiad();
	let starts = 0;
	return {
		fake,
		starts: () => starts,
		launch: async (): DriverResult<UiadClient> => {
			const next = results[Math.min(starts, results.length - 1)];
			starts++;
			if (next === undefined || next === "ok") {
				return startUiad({ cmd: ["adb", "shell", "x"], spawn: fake.spawn, graceMs: 20 });
			}
			return { success: false, error: next };
		},
	};
}

const open: Array<{ stop(): Promise<void> }> = [];

function backendWith(launch: Launch, extra: Partial<UiadBackendDeps> = {}) {
	const clock = fakeClock();
	const lines: string[] = [];
	const unsupported: string[] = [];
	const backend = createUiadBackend({
		session: SESSION,
		adb: "adb",
		serial: "emulator-5554",
		clock,
		log: (line) => lines.push(line),
		options: {},
		onUnsupported: (id) => unsupported.push(id),
		launch,
		...extra,
	});
	open.push(backend);
	return { backend, clock, lines, unsupported };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((b) => b.stop()));
});

describe("starting", () => {
	test("nothing is started until a call needs the server, and one start is shared by calls made together", async () => {
		const server = connecting(fakeUiad());
		const { backend } = backendWith(server.launch);
		expect(server.starts()).toBe(0);
		expect(backend.status()).toBe("idle");
		const [a, b, c] = await Promise.all([backend.server(), backend.server(), backend.server()]);
		expect(server.starts()).toBe(1);
		expect(a).toBeDefined();
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(backend.status()).toBe("up");
		expect(await backend.server()).toBe(a);
		expect(server.starts()).toBe(1);
	});

	test("a server that died is started again by the next call", async () => {
		const fake = fakeUiad();
		const server = connecting(fake);
		const { backend } = backendWith(server.launch);
		const first = await backend.server();
		fake.killAll();
		await Bun.sleep(5);
		const second = await backend.server();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(server.starts()).toBe(2);
	});

	test("a call that failed stops the server so the dump can have the slot, and the next call starts a new one", async () => {
		const fake = fakeUiad();
		const server = connecting(fake);
		const { backend, lines } = backendWith(server.launch);
		await backend.server();
		expect(fake.running()).toBe(1);
		await backend.failed(driverError("E_TIMEOUT", "warden-uiad did not answer `tap` within 10000ms"));
		expect(fake.running()).toBe(0);
		expect(lines.some((l) => l.includes("E_TIMEOUT"))).toBe(true);
		expect(await backend.server()).toBeDefined();
		expect(server.starts()).toBe(2);
	});

	test("a server that keeps dying is given up on, and the driver goes on with the dump", async () => {
		const server = connecting(fakeUiad());
		const { backend, lines } = backendWith(server.launch);
		for (let i = 0; i < 4; i++) {
			expect(await backend.server()).toBeDefined();
			await backend.failed(driverError("E_HELPER_CRASHED", "gone"));
		}
		expect(await backend.server()).toBeUndefined();
		expect(backend.wanted()).toBe(false);
		expect(backend.status()).toContain("off");
		expect(lines.some((l) => l.includes("died 4 times"))).toBe(true);
		expect(server.starts()).toBe(4);
	});
});

describe("start failures", () => {
	test("one failed start falls back for that call and the next call tries again", async () => {
		const scripts = scripted(driverError("E_HELPER_CRASHED", "warden-uiad exited (exit 1)"), "ok");
		const { backend, unsupported } = backendWith(scripts.launch);
		expect(await backend.server()).toBeUndefined();
		expect(backend.wanted()).toBe(true);
		expect(await backend.server()).toBeDefined();
		expect(unsupported).toEqual([]);
	});

	test("two failed starts in a row end it for this driver, without writing anything down", async () => {
		const scripts = scripted(driverError("E_HELPER_CRASHED", "warden-uiad exited (exit 1)"));
		const { backend, unsupported } = backendWith(scripts.launch);
		expect(await backend.server()).toBeUndefined();
		expect(await backend.server()).toBeUndefined();
		expect(backend.wanted()).toBe(false);
		expect(await backend.server()).toBeUndefined();
		expect(scripts.starts()).toBe(2);
		expect(unsupported).toEqual([]);
	});

	test("a start that can never work here is remembered for this build, so no later process pays for it", async () => {
		const scripts = scripted(driverError("E_UNSUPPORTED", "warden-uiad speaks protocol 2, this client speaks 1"));
		const { backend, unsupported } = backendWith(scripts.launch);
		expect(await backend.server()).toBeUndefined();
		expect(backend.wanted()).toBe(false);
		expect(unsupported).toEqual([uiadBuildId()]);
		expect(await backend.server()).toBeUndefined();
		expect(scripts.starts()).toBe(1);
	});

	test("so is a UiAutomation that cannot be connected from this shell", async () => {
		const scripts = scripted(
			driverError("E_AX_UNAVAILABLE", "cannot connect UiAutomation", { detail: { reason: "connect_failed" } })
		);
		const { backend, unsupported } = backendWith(scripts.launch);
		expect(await backend.server()).toBeUndefined();
		expect(unsupported).toEqual([uiadBuildId()]);
	});

	test("a build recorded as unsupported is not started at all; another build is", async () => {
		const scripts = scripted("ok");
		const skipped = backendWith(scripts.launch, { unsupportedBuild: uiadBuildId() });
		expect(skipped.backend.wanted()).toBe(false);
		expect(await skipped.backend.server()).toBeUndefined();
		expect(scripts.starts()).toBe(0);

		const other = backendWith(scripts.launch, { unsupportedBuild: "00000000" });
		expect(other.backend.wanted()).toBe(true);
		expect(await other.backend.server()).toBeDefined();
	});
});

describe("a busy UiAutomation slot", () => {
	test("is reported as what it is, not retried on every call, and not remembered as unsupported", async () => {
		const scripts = scripted(BUSY, BUSY, "ok");
		const { backend, clock, unsupported } = backendWith(scripts.launch);
		expect(await backend.server()).toBeUndefined();
		expect(backend.blocked()).toEqual(BUSY);
		expect(backend.status()).toBe("busy");
		expect(backend.wanted()).toBe(true);

		clock.advance(500);
		expect(await backend.server()).toBeUndefined();
		expect(scripts.starts()).toBe(1);

		clock.advance(2_000);
		expect(await backend.server()).toBeUndefined();
		expect(scripts.starts()).toBe(2);

		clock.advance(2_000);
		expect(await backend.server()).toBeDefined();
		expect(backend.blocked()).toBeUndefined();
		expect(unsupported).toEqual([]);
	});

	test("never gives up for good: whoever holds the slot will let go", async () => {
		const scripts = scripted(BUSY);
		const { backend, clock } = backendWith(scripts.launch);
		for (let i = 0; i < 6; i++) {
			await backend.server();
			clock.advance(2_500);
		}
		expect(backend.wanted()).toBe(true);
		expect(scripts.starts()).toBe(6);
	});

	test("another failure after a busy one clears the busy report: the dump may be tried", async () => {
		const scripts = scripted(BUSY, driverError("E_HELPER_CRASHED", "gone"));
		const { backend, clock } = backendWith(scripts.launch);
		await backend.server();
		clock.advance(2_500);
		await backend.server();
		expect(backend.blocked()).toBeUndefined();
	});
});

describe("stop", () => {
	test("ends the running server and is safe to call twice", async () => {
		const fake = fakeUiad();
		const { backend } = backendWith(connecting(fake).launch);
		await backend.server();
		await backend.stop();
		await backend.stop();
		expect(fake.running()).toBe(0);
	});

	test("ends a server that was still starting", async () => {
		const fake = fakeUiad();
		const { backend } = backendWith(connecting(fake).launch);
		const pending = backend.server();
		await backend.stop();
		await pending;
		expect(fake.running()).toBe(0);
	});

	test("without a server there is nothing to do", async () => {
		const { backend } = backendWith(connecting(fakeUiad()).launch);
		await backend.stop();
		expect(backend.status()).toBe("idle");
	});
});

describe("isPersistentStartFailure", () => {
	test("is true for an unsupported device and for UiAutomation that cannot connect, false for a crash or a timeout", () => {
		expect(isPersistentStartFailure(driverError("E_UNSUPPORTED", "x"))).toBe(true);
		expect(
			isPersistentStartFailure(driverError("E_AX_UNAVAILABLE", "x", { detail: { reason: "connect_failed" } }))
		).toBe(true);
		expect(isPersistentStartFailure(driverError("E_HELPER_CRASHED", "x"))).toBe(false);
		expect(isPersistentStartFailure(driverError("E_TIMEOUT", "x"))).toBe(false);
		expect(isPersistentStartFailure(driverError("E_AX_UNAVAILABLE", "x"))).toBe(false);
	});
});

describe("with the real launcher", () => {
	test("starts the server the device way and reports it up", async () => {
		const fake = fakeUiad();
		const { backend } = backendWith(launchUiad, {
			options: { spawn: fake.spawn, push: async () => ({ exitCode: 0, output: "" }) },
			session: {
				async run() {
					return { success: true, data: { stdout: "present\n", exitCode: 0 } };
				},
				async close() {},
			},
			launch: undefined,
		});
		expect(await backend.server()).toBeDefined();
		expect(fake.commands[0]?.at(-1)).toContain("app_process / nz.co.delacour.warden.uiad.Main");
		expect(backend.status()).toBe("up");
	});
});

describe("uiadFromEnv", () => {
	test("the server is on unless WARDEN_ANDROID_UIAD is 0", () => {
		expect(uiadFromEnv({})).toBe(true);
		expect(uiadFromEnv({ WARDEN_ANDROID_UIAD: "1" })).toBe(true);
		expect(uiadFromEnv({ WARDEN_ANDROID_UIAD: "" })).toBe(true);
		expect(uiadFromEnv({ WARDEN_ANDROID_UIAD: "0" })).toBeUndefined();
	});
});
