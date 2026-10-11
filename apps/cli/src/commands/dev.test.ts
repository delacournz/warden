import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devClientLaunchArgv, type MetroProc } from "../metro";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import type { EnsureOptions } from "./app";
import { createDevCommand, type DevDeps, devClientUrl } from "./dev";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Harness = {
	deps: DevDeps;
	spawned: Array<{ cmd: string[]; cwd: string; env: Record<string, string | undefined>; stdout: string }>;
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

/** A context whose cwd holds an Expo app (`app.json`, slug `demo`). */
function setup(argv: string[], calls: string[][], extra: Array<[string, { stdout?: string }]> = []): TestContext {
	ctx = testContext(argv, {
		exec: fakeSimctl([wardenSim(1, "Booted")], calls, [
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
		expect(metro?.env.WARDEN_UDID_0).toBe("U1");
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

	test("an explicit --variant must exist", async () => {
		const c = setup(["ios", "--variant", "qa"], []);
		const h = harness();
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain('variant "qa"');
		expect(h.spawned).toEqual([]);
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

	test("app not ready → exit 1, Metro never started, nothing leased", async () => {
		const calls: string[][] = [];
		const c = setup(["ios"], calls);
		const h = harness();
		h.deps.ensureApp = async () => ({ success: false, error: "local build failed" });
		expect(await createDevCommand(h.deps).run(c)).toBe(1);
		expect(h.spawned).toEqual([]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("local build failed");
	});

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
