import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowAutoGc, autoGcConsidered, autoGcOrder } from "../autogc.testing";
import { main } from "../cli";
import type { CommandContext } from "../context";
import { devClientLaunchArgv, type MetroProc } from "../metro";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type ScriptedUi, scriptedUi, type TestContext, testContext } from "../testing";
import type { EnsureOptions } from "./app";
import {
	createDevCommand,
	type DevDeps,
	type DevSpawnOutput,
	type DevUiOpts,
	defaultDevDeps,
	devClientUrl,
	selectDevUi,
} from "./dev";
import type { DevMetroMode, DevReady, DevUi, MetroTerminal } from "./dev-ui";
import { plainDevUi } from "./dev-ui.plain";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Harness = {
	deps: DevDeps;
	spawned: Array<{ cmd: string[]; cwd: string; env: Record<string, string | undefined>; stdout: DevSpawnOutput }>;
	ensured: Array<{ deviceId: string; opts: EnsureOptions }>;
	finish: (code: number) => void;
};

function harness(): Harness {
	let resolveExit: (code: number) => void = () => {};
	const h: Harness = {
		spawned: [],
		ensured: [],
		finish: (code) => resolveExit(code),
		deps: {
			pid: 777,
			isPortFree: async () => true,
			spawn: (cmd, env, cwd, stdout): MetroProc => {
				h.spawned.push({ cmd, env, cwd, stdout });
				return {
					exited: new Promise<number>((resolve) => {
						resolveExit = resolve;
					}),
					kill: () => {},
				};
			},
			onSignal: () => () => {},
			every: () => () => {},
			probe: async () => ({ kind: "ours" }),
			sleep: async () => {},
			ensureApp: async (_ctx, _owner, _platform, deviceId, opts) => {
				h.ensured.push({ deviceId, opts });
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			},
		},
	};
	return h;
}

/** A context whose cwd holds an Expo app (`app.json`, slug `demo`); the one warden sim is `state` (booted by default). */
function setup(
	argv: string[],
	calls: string[][],
	extra: Array<[string, { stdout?: string; exitCode?: number }]> = [],
	state: "Booted" | "Shutdown" = "Booted"
): TestContext {
	ctx = testContext(argv, {
		exec: fakeSimctl([wardenSim(1, state)], calls, [
			["git rev-parse --show-toplevel", { stdout: "" }],
			["git config --get remote.origin.url", { stdout: "git@github.com:o/r.git" }],
			["xcrun simctl launch", {}],
			["adb", {}],
			...extra,
		]),
	});
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	const app = join(ctx.cwd, "app");
	mkdirSync(app, { recursive: true });
	writeFileSync(
		join(app, "app.json"),
		JSON.stringify({ expo: { slug: "demo", ios: { bundleIdentifier: "com.demo" }, android: { package: "com.demo" } } })
	);
	ctx.cwd = app;
	return ctx;
}

async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(1);
}

describe("devClientUrl", () => {
	test("exp+<slug> dev-client link to the local Metro", () => {
		expect(devClientUrl("exp+demo", 8082)).toBe(
			"exp+demo://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8082"
		);
	});
});

describe("warden dev: showing the simulator", () => {
	const hubRunning: Array<[string, { stdout?: string; exitCode?: number }]> = [
		["pgrep -xq Simulator", { exitCode: 1 }],
		["pgrep -xq DeviceHub", { exitCode: 0 }],
		["open", {}],
	];
	const shown = (calls: string[][]) => calls.filter((cmd) => cmd[0] === "open");

	test("the leased sim's window is brought to the front once it is held, before the dev client opens", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls, hubRunning);
		const ui = scriptedUi();
		c.ui = ui;
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(shown(calls)).toEqual([["open", "devices://device/open?id=U1"]]);
		expect(calls.findIndex((cmd) => cmd[0] === "open")).toBeLessThan(calls.findIndex((cmd) => cmd.includes("launch")));
		expect(ui.events.some((e) => e.includes("showing U1 in Device Hub"))).toBe(true);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("--headless → no window is shown", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--headless"], calls, hubRunning);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(shown(calls)).toEqual([]);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("a device already held (--udid) is shown too", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--udid", "U1"], calls, hubRunning);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(shown(calls)).toEqual([["open", "devices://device/open?id=U1"]]);
		h.finish(0);
		expect(await running).toBe(0);
	});
});

describe("warden dev: the simulator when dev ends", () => {
	const shutdowns = (calls: string[][]) => calls.filter((cmd) => cmd[1] === "simctl" && cmd[2] === "shutdown");

	test("Metro exits → the sim dev booted is shut down before its lease goes", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls, [], "Shutdown");
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(shutdowns(calls)).toEqual([]);
		h.finish(0);
		expect(await running).toBe(0);
		expect(shutdowns(calls)).toEqual([["xcrun", "simctl", "shutdown", "U1"]]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("the shut-down sim's viewer window is closed too (Device Hub running)", async () => {
		const calls: string[][] = [];
		const c = setup(
			["ios"],
			calls,
			[
				["pgrep -xq Simulator", { exitCode: 1 }],
				["pgrep -xq DeviceHub", { exitCode: 0 }],
				["open", {}],
				["osascript", {}],
			],
			"Shutdown"
		);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		expect(await running).toBe(0);
		const closes = calls.filter((cmd) => cmd[0] === "osascript" && (cmd[4] ?? "").includes("AXCloseButton"));
		expect(closes).toHaveLength(1);
		expect(JSON.parse(closes[0]?.[5] ?? "")).toEqual(["warden-iphone-17-1"]);
		expect(calls.indexOf(closes[0] as string[])).toBeGreaterThan(
			calls.findIndex((cmd) => cmd[1] === "simctl" && cmd[2] === "shutdown")
		);
	});

	test("--no-shutdown → the window stays with the sim", async () => {
		const calls: string[][] = [];
		const c = setup(
			["ios", "--no-shutdown"],
			calls,
			[
				["pgrep -xq Simulator", { exitCode: 1 }],
				["pgrep -xq DeviceHub", { exitCode: 0 }],
				["open", {}],
				["osascript", {}],
			],
			"Shutdown"
		);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		expect(await running).toBe(0);
		expect(calls.filter((cmd) => cmd[0] === "osascript" && (cmd[4] ?? "").includes("AXCloseButton"))).toEqual([]);
	});

	test("a sim that was already running when dev leased it is left running", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls, [], "Booted");
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		expect(await running).toBe(0);
		expect(shutdowns(calls)).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--no-shutdown → released, left booted", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--no-shutdown"], calls, [], "Shutdown");
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		expect(await running).toBe(0);
		expect(shutdowns(calls)).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("a device dev did not lease itself (--udid) is left running", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--udid", "U1"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		expect(await running).toBe(0);
		expect(shutdowns(calls)).toEqual([]);
	});

	test("the terminal goes away (SIGHUP) → Metro stopped, sim shut down, leases released", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls, [], "Shutdown");
		const h = harness();
		const signals = new Map<string, () => void>();
		h.deps.onSignal = (signal, handler) => {
			signals.set(signal, handler);
			return () => signals.delete(signal);
		};
		const kills: string[] = [];
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env, cwd, stdout) => {
			const child = spawn(cmd, env, cwd, stdout);
			return {
				exited: child.exited,
				kill: (signal) => {
					kills.push(signal);
					h.finish(129);
				},
			};
		};
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		const hup = signals.get("SIGHUP");
		expect(hup).toBeDefined();
		hup?.();
		expect(await running).toBe(129);
		expect(kills).toEqual(["SIGHUP"]);
		expect(shutdowns(calls)).toEqual([["xcrun", "simctl", "shutdown", "U1"]]);
		expect(c.db.listLeases()).toEqual([]);
	});
});

describe("warden dev", () => {
	test("claims a device + Metro port, ensures the dev variant, starts Metro, opens the dev client, releases", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--", "--clear"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));

		expect(h.ensured).toHaveLength(1);
		expect(h.ensured[0]?.deviceId).toBe("U1");
		expect(h.ensured[0]?.opts).toMatchObject({ variant: "dev", variantOptional: true, eas: true, build: true });

		const metro = h.spawned[0];
		expect(metro?.cwd).toBe(c.cwd);
		expect(metro?.cmd).toEqual(["bunx", "expo", "start", "--dev-client", "--port", "8081", "--clear"]);
		// Metro starts before the device is claimed: its env carries the port, not the udid
		expect(metro?.env.WARDEN_PORT_0).toBe("8081");
		expect(metro?.env.WARDEN_PORT).toBeUndefined();
		expect(metro?.stdout).toBe("inherit");
		expect(calls).toContainEqual(devClientLaunchArgv("U1", "com.demo", "http://127.0.0.1:8081"));
		expect(calls.some((cmd) => cmd.includes("openurl"))).toBe(false);
		expect(
			c.db
				.listLeases()
				.map((l) => l.resource.kind)
				.sort()
		).toEqual(["device", "port"]);

		h.finish(0);
		expect(await running).toBe(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("no platform → ios, without asking", async () => {
		const calls: string[][] = [];
		const c = setup([], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(h.ensured[0]?.deviceId).toBe("U1");
		expect(calls).toContainEqual(devClientLaunchArgv("U1", "com.demo", "http://127.0.0.1:8081"));
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("expo-dev-client not installed → exit 1 with the install command, nothing leased", async () => {
		const c = setup(["ios"], []);
		writeFileSync(join(c.cwd, "package.json"), JSON.stringify({ dependencies: { expo: "~57.0.0" } }));
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("bunx expo install expo-dev-client");
		expect(h.ensured).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("no bundle id in app.json → exit 1 naming the app.json key, nothing leased", async () => {
		const c = setup(["ios"], []);
		writeFileSync(join(c.cwd, "app.json"), JSON.stringify({ expo: { slug: "demo" } }));
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("expo.ios.bundleIdentifier");
		expect(h.ensured).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("headless only with an explicit --headless: config / WARDEN_HEADLESS are ignored", async () => {
		const metroEnv = async (argv: string[], env: Record<string, string> = {}) => {
			const calls: string[][] = [];
			const c = setup(argv, calls);
			c.env = { ...c.env, ...env };
			const h = harness();
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
			h.finish(0);
			await running;
			c.cleanup();
			return h.spawned[0]?.env ?? {};
		};
		expect((await metroEnv(["ios", "--headless"])).WARDEN_HEADLESS).toBe("1");
		expect("WARDEN_HEADLESS" in (await metroEnv(["ios"], { WARDEN_HEADLESS: "1" }))).toBe(false);
	});

	test("an explicit --variant must exist", async () => {
		const c = setup(["ios", "--variant", "qa"], []);
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain('variant "qa"');
		expect(h.spawned).toEqual([]);
	});

	test("the device lease it claims is shared (warden ui attaches to it); the port lease is not", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		const byKind = Object.fromEntries(c.db.listLeases().map((l) => [l.resource.kind, l]));
		expect(byKind.device?.shared).toBe(true);
		expect(byKind.device?.label).toBe("warden dev");
		expect(byKind.port?.shared).toBeUndefined();
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("--udid reuses that device (no device claim)", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--udid", "U9"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(h.ensured[0]?.deviceId).toBe("U9");
		expect(calls).toContainEqual(devClientLaunchArgv("U9", "com.demo", "http://127.0.0.1:8081"));
		expect(c.db.listLeases().map((l) => l.resource.kind)).toEqual(["port"]);
		h.finish(0);
		expect(await running).toBe(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("android: adb reverse for the Metro port, then opens the link in the app; --scheme overrides exp+<slug>", async () => {
		const calls: string[][] = [];
		const c = setup(["android", "--udid", "emulator-5554", "--scheme", "myapp"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("am")));
		const joined = calls.map((cmd) => cmd.join(" "));
		expect(joined).toContain("adb -s emulator-5554 reverse tcp:8081 tcp:8081");
		expect(joined).toContain(
			`adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d ${devClientUrl("myapp", 8081)} com.demo`
		);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("app not ready → Metro was started early and is killed, exit 1, nothing leased", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const h = harness();
		h.deps.ensureApp = async () => ({ success: false, error: "local build failed" });
		const kills: string[] = [];
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env, cwd, stdout) => {
			const child = spawn(cmd, env, cwd, stdout);
			return {
				exited: child.exited,
				kill: (signal) => {
					kills.push(signal);
					h.finish(143);
				},
			};
		};
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(h.spawned).toHaveLength(1);
		expect(kills).toEqual(["SIGTERM"]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("local build failed");
	});

	for (const [name, argv] of [
		["claimed device", ["ios"]],
		["--udid U1", ["ios", "--udid", "U1"]],
	] as const) {
		test(`Metro is spawned before the app install finishes (${name})`, async () => {
			const calls: string[][] = [];
			const c = setup([...argv], calls);
			const h = harness();
			const gate = Promise.withResolvers<void>();
			h.deps.ensureApp = async (_ctx, _owner, _platform, deviceId, opts) => {
				h.ensured.push({ deviceId, opts });
				await gate.promise;
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			};
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => h.spawned.length === 1 && h.ensured.length === 1);
			expect(h.spawned).toHaveLength(1);
			expect(h.ensured).toHaveLength(1);
			expect(calls.some((cmd) => cmd.includes("launch"))).toBe(false);
			gate.resolve();
			await waitFor(() => calls.some((cmd) => cmd.includes("launch")));
			h.finish(0);
			expect(await running).toBe(0);
			expect(c.db.listLeases()).toEqual([]);
		});
	}

	test("Metro never ready → Metro killed, exit 1, released", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--ready-timeout", "1s"], calls);
		const h = harness();
		h.deps.probe = async () => ({ kind: "down" });
		const kills: string[] = [];
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env, cwd, stdout) => {
			const child = spawn(cmd, env, cwd, stdout);
			return {
				exited: child.exited,
				kill: (signal) => {
					kills.push(signal);
					h.finish(143);
				},
			};
		};
		let clock = 0;
		c.now = () => clock;
		h.deps.sleep = async (ms) => {
			clock += ms;
		};
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(kills).toEqual(["SIGTERM"]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("a foreign Metro on the leased port → exit 1 naming its root, dev client never opened", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const h = harness();
		h.deps.probe = async () => ({ kind: "foreign", root: "/other/checkout/app" });
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0);
		h.finish(143);
		expect(await running).toBe(1);
		expect(c.stderr.join("\n")).toContain("port 8081 is served by /other/checkout/app, not this worktree");
		expect(calls.some((cmd) => cmd.includes("launch"))).toBe(false);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--json: one JSON line on stdout once Metro is ready; Metro's own stdout goes to stderr", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--json", "--no-open"], calls);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => c.stdout.length > 0);
		const leaseIds = c.db.listLeases().map((l) => l.id);
		const doc = JSON.parse(c.stdout.join("\n"));
		expect(doc).toMatchObject({ udid: "U1", port: 8081, metroUrl: "http://127.0.0.1:8081" });
		expect([...doc.leaseIds].sort()).toEqual([...leaseIds].sort());
		expect(h.spawned[0]?.stdout).toBe("stderr");
		expect(calls.some((cmd) => cmd.includes("launch"))).toBe(false);
		h.finish(0);
		expect(await running).toBe(0);
	});

	test("Metro runs the project's own expo bin directly (no bunx) when there is one", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--", "--clear"], calls);
		const h = harness();
		h.deps.expoBin = (root) => `${root}/node_modules/.bin/expo`;
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(h.spawned[0]?.cmd).toEqual([
			`${c.cwd}/node_modules/.bin/expo`,
			"start",
			"--dev-client",
			"--port",
			"8081",
			"--clear",
		]);
		h.finish(0);
		expect(await running).toBe(0);
	});

	describe("the dev-client scheme (an app.json without a slug needs `expo config`, 1-3 s)", () => {
		const noSlug = (c: TestContext) =>
			writeFileSync(
				join(c.cwd, "app.json"),
				JSON.stringify({ expo: { ios: { bundleIdentifier: "com.demo" }, android: { package: "com.demo" } } })
			);
		const expoConfig = (calls: string[][]) => calls.filter((cmd) => cmd.join(" ").startsWith("bunx expo config"));
		const slugOut: [string, { stdout: string }] = ["bunx expo config", { stdout: JSON.stringify({ slug: "demo" }) }];

		test("ios: never read — the dev client is opened with --initialUrl, not a deep link", async () => {
			const calls: string[][] = [];
			const c = setup(["ios"], calls, [slugOut]);
			noSlug(c);
			const h = harness();
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
			expect(expoConfig(calls)).toEqual([]);
			h.finish(0);
			expect(await running).toBe(0);
		});

		test("ios: read only to word the hint when the dev client could not be opened", async () => {
			const calls: string[][] = [];
			const c = setup(["ios"], calls, [slugOut]);
			noSlug(c);
			const exec = c.exec;
			c.exec = async (cmd, opts) =>
				cmd.includes("launch") ? { exitCode: 1, stdout: "", stderr: "boom" } : exec(cmd, opts);
			const h = harness();
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => c.stderr.join("\n").includes("yourself"));
			expect(expoConfig(calls)).toHaveLength(1);
			expect(c.stderr.join("\n")).toContain(devClientUrl("exp+demo", 8081));
			h.finish(0);
			expect(await running).toBe(0);
		});

		test("android: read while the app installs, not before the claim, and used for the deep link", async () => {
			const calls: string[][] = [];
			const c = setup(["android", "--udid", "emulator-5554"], calls, [slugOut]);
			noSlug(c);
			const h = harness();
			const gate = Promise.withResolvers<void>();
			let configReadBeforeInstallEnded = false;
			h.deps.ensureApp = async (_ctx, _owner, _platform, deviceId, opts) => {
				h.ensured.push({ deviceId, opts });
				await waitFor(() => expoConfig(calls).length > 0);
				configReadBeforeInstallEnded = expoConfig(calls).length > 0;
				await gate.promise;
				return { success: true, data: { appPath: "/c/A.app", hash: "H", source: "cache", installed: true } };
			};
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => h.ensured.length === 1);
			gate.resolve();
			await waitFor(() => calls.some((cmd) => cmd.includes("am")));
			expect(configReadBeforeInstallEnded).toBe(true);
			expect(calls.map((cmd) => cmd.join(" "))).toContain(
				`adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d ${devClientUrl("exp+demo", 8081)} com.demo`
			);
			h.finish(0);
			expect(await running).toBe(0);
		});

		test("android --no-open: never read (nothing opens a deep link)", async () => {
			const calls: string[][] = [];
			const c = setup(["android", "--udid", "emulator-5554", "--no-open"], calls, [slugOut]);
			noSlug(c);
			const h = harness();
			const running = createDevCommand(h.deps).run(c);
			await waitFor(() => c.stderr.join("\n").includes("holding"));
			expect(expoConfig(calls)).toEqual([]);
			h.finish(0);
			expect(await running).toBe(0);
		});

		test("android: an unreadable slug still fails the run — Metro stopped, nothing leased", async () => {
			const calls: string[][] = [];
			const c = setup(["android", "--udid", "emulator-5554"], calls, [["bunx expo config", { exitCode: 1 }]]);
			noSlug(c);
			const h = harness();
			const kills: string[] = [];
			const spawn = h.deps.spawn;
			h.deps.spawn = (cmd, env, cwd, stdout) => {
				const child = spawn(cmd, env, cwd, stdout);
				return {
					exited: child.exited,
					kill: (signal) => {
						kills.push(signal);
						h.finish(143);
					},
				};
			};
			expect(await createDevCommand(h.deps).run(c)).toBe(1);
			expect(c.stderr.join("\n")).toContain("could not read the app slug");
			expect(kills).toEqual(["SIGTERM"]);
			expect(c.db.listLeases()).toEqual([]);
			expect(calls.some((cmd) => cmd.includes("am"))).toBe(false);
		});
	});

	test("--project that is not a directory → clear error before anything is claimed", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--project", "nope"], calls);
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain(`--project nope: no such directory ${join(c.cwd, "nope")} (cwd ${c.cwd})`);
		expect(calls).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
	});
});

describe("warden dev auto-gc (16-1)", () => {
	test("auto-gc is considered only after the device has been claimed", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const order = autoGcOrder(c.exec, () => c.db);
		c.exec = order.exec;
		c.env = allowAutoGc(c.env);
		const h = harness();
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		expect(order.gcBeforeClaim()).toBe(false);
		expect(autoGcConsidered(c.db)).toBe(true);
		h.finish(0);
		expect(await running).toBe(0);
	});
});

describe("warden dev: Metro in a PTY (default spawn)", () => {
	type SpawnOpts = {
		cwd: string;
		env: Record<string, string | undefined>;
		terminal: { cols: number; rows: number; data(terminal: unknown, chunk: Uint8Array): void };
	};

	test("passes cols / rows, drops CI, sets TERM, forwards raw chunks, write and resize", async () => {
		const seen: SpawnOpts[] = [];
		const writes: Array<string | Uint8Array> = [];
		const resizes: Array<[number, number]> = [];
		const fake = {
			exited: Promise.resolve(0),
			signalCode: null,
			kill: () => {},
			terminal: {
				write: (data: string | Uint8Array) => void writes.push(data),
				resize: (cols: number, rows: number) => void resizes.push([cols, rows]),
			},
		};
		const spy = spyOn(Bun, "spawn").mockImplementation(((_cmd: unknown, opts: SpawnOpts) => {
			seen.push(opts);
			return fake;
		}) as unknown as typeof Bun.spawn);
		try {
			const chunks: Uint8Array[] = [];
			const proc = defaultDevDeps.spawn(["expo", "start"], { CI: "1", PATH: "/bin", EXPO_NO_TELEMETRY: "1" }, "/proj", {
				kind: "pty",
				cols: 80,
				rows: 24,
				onData: (chunk) => void chunks.push(chunk),
			});
			const opts = seen[0];
			expect(opts?.cwd).toBe("/proj");
			expect(opts?.terminal.cols).toBe(80);
			expect(opts?.terminal.rows).toBe(24);
			expect(opts?.env).toEqual({ PATH: "/bin", EXPO_NO_TELEMETRY: "1", TERM: "xterm-256color" });
			expect(opts?.env && "CI" in opts.env).toBe(false);
			const bytes = new Uint8Array([0xe2, 0x96]);
			opts?.terminal.data(undefined, bytes);
			expect(chunks[0]).toBe(bytes);
			proc.terminal?.write("r");
			proc.terminal?.resize(100, 30);
			expect(writes).toEqual(["r"]);
			expect(resizes).toEqual([[100, 30]]);
			expect(await proc.exited).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	test("the other modes keep the parent env (CI included) and have no terminal", () => {
		const seen: Array<{ env: Record<string, string | undefined>; terminal?: unknown }> = [];
		const spy = spyOn(Bun, "spawn").mockImplementation(((
			_cmd: unknown,
			opts: { env: Record<string, string | undefined> }
		) => {
			seen.push(opts);
			return { exited: Promise.resolve(0), signalCode: null, kill: () => {} };
		}) as unknown as typeof Bun.spawn);
		try {
			const proc = defaultDevDeps.spawn(["x"], { CI: "1" }, "/p", "inherit");
			expect(seen[0]?.env).toEqual({ CI: "1" });
			expect(seen[0]?.terminal).toBeUndefined();
			expect(proc.terminal).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("warden dev: a ui that runs Metro in a PTY", () => {
	type Fake = {
		ui: DevUi;
		attached: Array<{ terminal: MetroTerminal; exited: Promise<number> }>;
		quit: () => void;
		closes: string[];
	};
	function fakeUi(c: TestContext): Fake {
		const attached: Fake["attached"] = [];
		let onQuit: () => void = () => {};
		const closes: string[] = [];
		const metro: DevMetroMode = {
			kind: "pty",
			size: () => ({ cols: 90, rows: 30 }),
			onData: () => {},
			attach: (terminal, exited) => void attached.push({ terminal, exited }),
		};
		return {
			ui: {
				...plainDevUi(c),
				metro,
				onQuit: (handler) => {
					onQuit = handler;
				},
				close: async () => {
					closes.push("close");
				},
			},
			attached,
			quit: () => onQuit(),
			closes,
		};
	}

	/** harness whose spawned Metro has a PTY terminal and records how it was killed */
	function ptyHarness(): Harness & { writes: string[]; kills: string[] } {
		const h = harness() as Harness & { writes: string[]; kills: string[] };
		h.writes = [];
		h.kills = [];
		const spawn = h.deps.spawn;
		h.deps.spawn = (cmd, env, cwd, stdout) => {
			const child = spawn(cmd, env, cwd, stdout);
			return {
				exited: child.exited,
				kill: (signal) => {
					h.kills.push(signal);
					h.finish(130);
				},
				terminal: { write: (data) => void h.writes.push(String(data)), resize: () => {} },
			};
		};
		return h;
	}

	test("Metro is spawned in PTY mode at the ui's size and the ui gets its terminal and exit", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const fake = fakeUi(c);
		const h = ptyHarness();
		h.deps.selectUi = () => fake.ui;
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		const out = h.spawned[0]?.stdout;
		expect(typeof out === "object" && out.kind === "pty" ? [out.cols, out.rows] : undefined).toEqual([90, 30]);
		expect(fake.attached).toHaveLength(1);
		fake.attached[0]?.terminal.write("r");
		expect(h.writes).toEqual(["r"]);
		h.finish(7);
		expect(await fake.attached[0]?.exited).toBe(7);
		expect(await running).toBe(7);
		expect(fake.closes.length).toBeGreaterThan(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("ready carries the device name and the app's source and hash; no spinner runs in PTY mode", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const events = (c.ui as ScriptedUi).events;
		const fake = fakeUi(c);
		const readies: DevReady[] = [];
		fake.ui.ready = (info) => void readies.push(info);
		const h = ptyHarness();
		h.deps.selectUi = () => fake.ui;
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => readies.length > 0);
		expect(readies[0]).toMatchObject({ platform: "ios", deviceId: "U1", app: { source: "cache", hash: "H" } });
		expect(readies[0]?.deviceName).toEqual(expect.any(String));
		expect(events.filter((e) => e.startsWith("spin:"))).toEqual([]);
		h.finish(0);
		await running;
	});

	test("the ui quitting ends the session like SIGINT: Metro killed, sim shut down, leases released", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls, [], "Shutdown");
		const fake = fakeUi(c);
		const h = ptyHarness();
		h.deps.selectUi = () => fake.ui;
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		fake.quit();
		expect(await running).toBe(130);
		expect(h.kills).toEqual(["SIGINT"]);
		expect(calls.filter((cmd) => cmd[1] === "simctl" && cmd[2] === "shutdown")).toEqual([
			["xcrun", "simctl", "shutdown", "U1"],
		]);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("ui.close runs before the leases are released", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const fake = fakeUi(c);
		const leasesAtClose: number[] = [];
		const close = fake.ui.close;
		fake.ui.close = async () => {
			leasesAtClose.push(c.db.listLeases().length);
			await close();
		};
		const h = ptyHarness();
		h.deps.selectUi = () => fake.ui;
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		await running;
		expect(leasesAtClose[0]).toBeGreaterThan(0);
	});
});

describe("warden dev: HUD options", () => {
	async function runWith(argv: string[]) {
		const calls: string[][] = [];
		const c = setup(argv, calls);
		const h = harness();
		const seen: DevUiOpts[] = [];
		h.deps.selectUi = (rawCtx, opts) => {
			seen.push(opts);
			return plainDevUi(rawCtx);
		};
		const running = createDevCommand(h.deps).run(c);
		await waitFor(() => h.spawned.length > 0 && calls.some((cmd) => cmd.includes("launch")));
		h.finish(0);
		return { code: await running, seen, c };
	}

	test("the HUD is on at a 1 s interval by default", async () => {
		const { code, seen } = await runWith(["ios"]);
		expect(code).toBe(0);
		expect(seen[0]?.hud).toEqual({ enabled: true, intervalMs: 1000 });
	});

	test("--no-hud and --hud-interval reach the ui", async () => {
		const { code, seen } = await runWith(["ios", "--no-hud", "--hud-interval", "500ms"]);
		expect(code).toBe(0);
		expect(seen[0]?.hud).toEqual({ enabled: false, intervalMs: 500 });
	});

	test("--hud-interval under 200ms fails naming the floor, before anything is claimed", async () => {
		const calls: string[][] = [];
		const c = setup(["ios", "--hud-interval", "50ms"], calls);
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--hud-interval");
		expect(c.stderr.join("\n")).toContain("200ms");
		expect(h.spawned).toHaveLength(0);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("an unparsable --hud-interval fails too", async () => {
		const c = setup(["ios", "--hud-interval", "soon"], []);
		expect(await createDevCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--hud-interval");
	});
});

describe("selectDevUi", () => {
	type Loaded = { createDevTui: (deps: { ctx: CommandContext; hud: DevUiOpts["hud"] }) => DevUi };

	function loader() {
		const created: CommandContext[] = [];
		const huds: Array<DevUiOpts["hud"]> = [];
		const fake: DevUi = {
			ctx: testContext([]),
			task: () => ({ ok: () => {}, fail: () => {}, log: () => {} }),
			metro: { kind: "inherit" },
			ready: () => {},
			onQuit: () => {},
			close: async () => {},
		};
		const load = async (): Promise<Loaded> => ({
			createDevTui: ({ ctx: made, hud }) => {
				created.push(made);
				huds.push(hud);
				return fake;
			},
		});
		return { load, created, huds, fake };
	}

	const HUD = { enabled: true, intervalMs: 1000 };
	const opts = (o: Partial<DevUiOpts> = {}): DevUiOpts => ({ hud: HUD, ...o });

	function context(env: Record<string, string> = {}, ui = scriptedUi({ interactive: true, rich: true })) {
		ctx = testContext([], { ui, env: { ...testContext([]).env, ...env } });
		return ctx;
	}

	test("an interactive rich terminal gets the dashboard, loaded lazily", async () => {
		const l = loader();
		const c = context();
		const ui = await selectDevUi(c, opts({ tui: true }), l.load);
		expect(ui).toBe(l.fake);
		expect(l.created).toEqual([c]);
		expect(l.huds).toEqual([HUD]);
	});

	test("the dashboard is the default when --no-tui is not given (opts.tui undefined)", async () => {
		const l = loader();
		expect(await selectDevUi(context(), opts(), l.load)).toBe(l.fake);
	});

	test("plain for --json, --no-tui, WARDEN_TUI=0, pipes and non-rich terminals; the dashboard is never loaded", async () => {
		const cases: Array<[string, CommandContext, DevUiOpts]> = [
			["--json", context(), opts({ json: true })],
			["--no-tui", context(), opts({ tui: false })],
			["WARDEN_TUI=0", context({ WARDEN_TUI: "0" }), opts()],
			["not interactive", context({}, scriptedUi({ interactive: false, rich: true })), opts()],
			["not rich", context({}, scriptedUi({ interactive: true, rich: false })), opts()],
		];
		for (const [name, c, opts] of cases) {
			let loaded = false;
			const l = loader();
			const ui = await selectDevUi(c, opts, () => {
				loaded = true;
				return l.load();
			});
			expect([name, loaded, ui.metro.kind]).toEqual([name, false, "inherit"]);
		}
	});

	test("WARDEN_TUI=1 does not switch the dashboard on for a pipe", async () => {
		const l = loader();
		const ui = await selectDevUi(context({ WARDEN_TUI: "1" }, scriptedUi()), opts(), l.load);
		expect(ui.metro.kind).toBe("inherit");
	});

	test("--no-tui is documented in dev's help", async () => {
		let run: TestContext | undefined;
		const code = await main(["dev", "--help"], (rest) => {
			run = testContext(rest);
			return run;
		});
		const text = (run?.stdout ?? []).join("\n");
		run?.cleanup();
		expect(code).toBe(0);
		expect(text).toContain("--no-tui");
		expect(text).toContain("WARDEN_TUI=0");
	});
});
