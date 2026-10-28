import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import type { DevReady } from "../commands/dev-ui";
import { type TestContext, testContext } from "../testing";
import { fakeProcess, fakeStdin, fakeStdout, replay } from "./fakes.testing";
import { createDevTui, FRAME_MS } from "./tui";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const READY: DevReady = {
	platform: "ios",
	deviceId: "8F2A-1C3D",
	deviceName: "warden-iphone-17-5",
	port: 8101,
	metroUrl: "http://localhost:8101",
	leaseIds: ["lease-7"],
	app: { source: "cache", hash: "abc123" },
	projectName: "example",
	bundleId: "nz.example",
};

const settle = () => Bun.sleep(FRAME_MS * 4);

function setup(hud: { enabled: boolean; intervalMs: number } | undefined) {
	ctx = testContext([]);
	const stdout = fakeStdout(120, 40);
	const process = fakeProcess();
	const stdin = fakeStdin();
	const targets: string[] = [];
	let pending: (() => Promise<void>) | undefined;
	const ui = createDevTui({
		ctx,
		stdin: stdin.input,
		stdout: stdout.output,
		proc: process.proc,
		now: () => 5000,
		...(hud ? { hud } : {}),
		hudSeams: {
			sampler: async (_ctx, target) => {
				targets.push(`${target.platform}:${target.udid}:${target.app}`);
				return ok({
					sample: async () => ok({ wallMs: 0, atMs: 0, pid: 1, cpuPct: 21, rssKb: 204_800 }),
				});
			},
			schedule: (fn) => {
				pending = fn;
				return () => {
					pending = undefined;
				};
			},
		},
	});
	return {
		ui,
		stdin,
		stdout,
		targets,
		tick: async () => {
			const fn = pending;
			pending = undefined;
			await fn?.();
			await settle();
		},
		screen: () => replay(stdout.all(), 120, 40),
	};
}

describe("createDevTui: the HUD", () => {
	test("waits for the app, then shows the dev client's CPU and memory after ready()", async () => {
		const { ui, tick, screen, targets } = setup({ enabled: true, intervalMs: 1000 });
		await tick();
		expect((await screen()).join("\n")).toContain("waiting for the app");
		ui.ready(READY);
		await tick();
		const text = (await screen()).join("\n");
		expect(targets).toEqual(["ios:8F2A-1C3D:nz.example"]);
		expect(text).toContain("cpu  21%");
		expect(text).toContain("rss 200 MB");
		expect(text).toContain("hud on");
		await ui.close();
	});

	test("Metro's bundled line fills the metro row of the HUD", async () => {
		const { ui, tick, screen } = setup({ enabled: true, intervalMs: 1000 });
		ui.ready(READY);
		await tick();
		expect((await screen()).join("\n")).toContain("metro —");
		if (ui.metro.kind === "pty")
			ui.metro.onData(new TextEncoder().encode(" iOS Bundled 1234ms index.ts (412 modules)\r\n"));
		await settle();
		expect((await screen()).join("\n")).toContain("metro bundled 1.2 s · 412 mods");
		await ui.close();
	});

	test("disabled: no ticker, no box, header says hud off", async () => {
		const { ui, tick, screen, targets } = setup({ enabled: false, intervalMs: 1000 });
		ui.ready(READY);
		await tick();
		const text = (await screen()).join("\n");
		expect(targets).toEqual([]);
		expect(text).not.toContain("cpu");
		expect(text).toContain("hud off");
		await ui.close();
	});

	test("setHud(true) starts the ticker on a running session, setHud(false) stops it", async () => {
		const { ui, tick, screen, targets } = setup({ enabled: false, intervalMs: 1000 });
		ui.ready(READY);
		expect(ui.hudOn()).toBe(false);
		expect(ui.setHud(true)).toEqual(ok(undefined));
		expect(ui.hudOn()).toBe(true);
		await tick();
		expect(targets).toEqual(["ios:8F2A-1C3D:nz.example"]);
		expect((await screen()).join("\n")).toContain("hud on");
		ui.setHud(false);
		expect(ui.hudOn()).toBe(false);
		await tick();
		expect(targets).toHaveLength(1);
		expect((await screen()).join("\n")).toContain("hud off");
		await ui.close();
	});

	test("the h key starts and stops the ticker", async () => {
		const { ui, tick, targets, stdin } = setup({ enabled: false, intervalMs: 1000 });
		ui.ready(READY);
		stdin.press("h");
		await settle();
		expect(ui.hudOn()).toBe(true);
		await tick();
		expect(targets).toHaveLength(1);
		stdin.press("h");
		await settle();
		expect(ui.hudOn()).toBe(false);
		await ui.close();
	});

	test("close stops the ticker", async () => {
		const { ui, tick, targets } = setup({ enabled: true, intervalMs: 1000 });
		ui.ready(READY);
		await ui.close();
		await tick();
		expect(targets).toEqual([]);
	});
});

describe("createDevTui: the session log", () => {
	test("task lines, warden's own output and Metro bytes land under dev/<leaseId>", async () => {
		const { ui } = setup(undefined);
		ui.ctx.err("early line before the lease is known");
		const claim = ui.task("claim", "claiming");
		claim.log("picked warden-iphone-17-5");
		claim.ok("port 8101");
		ui.ready(READY);
		ui.metro.kind === "pty" && ui.metro.onData(new TextEncoder().encode("Bundled 412 modules\r\n"));
		ui.ctx.err("warden: after ready");
		await ui.close();
		const dir = join(ctx?.env.WARDEN_HOME ?? "", "dev", "lease-7");
		const log = readFileSync(join(dir, "warden.log"), "utf8");
		expect(log).toContain("[claim] early line before the lease is known");
		expect(log).toContain("[claim] picked warden-iphone-17-5");
		expect(log).toContain("[claim] port 8101");
		expect(log).toContain("[session] warden: after ready");
		expect(readFileSync(join(dir, "metro.log"), "utf8")).toBe("Bundled 412 modules\r\n");
	});

	test("nothing is written when no lease id ever arrives", async () => {
		const { ui } = setup(undefined);
		ui.ctx.err("line");
		ui.ready({ ...READY, leaseIds: [] });
		await ui.close();
		expect(existsSync(join(ctx?.env.WARDEN_HOME ?? "", "dev"))).toBe(false);
	});
});
