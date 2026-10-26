import { describe, expect, test } from "bun:test";
import type { DevReady } from "../commands/dev-ui";
import { testContext } from "../testing";
import { fakeProcess, fakeStdin, fakeStdout, replay } from "./fakes.testing";
import { createDevTui, FRAME_MS } from "./tui";

const READY: DevReady = {
	platform: "ios",
	deviceId: "8F2A-1C3D",
	deviceName: "warden-iphone-17-5",
	port: 8101,
	metroUrl: "http://localhost:8101",
	leaseIds: ["l1"],
	app: { source: "cache", hash: "abc123" },
	projectName: "example",
};

const settle = () => Bun.sleep(FRAME_MS * 3);

function setup() {
	const stdin = fakeStdin();
	const stdout = fakeStdout(80, 24);
	const process = fakeProcess();
	let clock = 1000;
	const ui = createDevTui({
		ctx: testContext([]),
		stdin: stdin.input,
		stdout: stdout.output,
		proc: process.proc,
		now: () => clock,
	});
	return {
		ui,
		stdin,
		stdout,
		process,
		advance: (ms: number) => {
			clock += ms;
		},
		screen: () => replay(stdout.all(), 80, 24),
	};
}

describe("createDevTui", () => {
	test("takes the alt screen on creation and gives it back on close", async () => {
		const { ui, stdout } = setup();
		expect(stdout.all()).toContain("\x1b[?1049h");
		await ui.close();
		expect(stdout.all().endsWith("\x1b[?2026l\x1b[?25h\x1b[?1049l")).toBe(true);
		await ui.close();
		expect(stdout.all().split("\x1b[?1049l")).toHaveLength(2);
	});

	test("task rows show running, done with a duration, and pending", async () => {
		const { ui, screen, advance } = setup();
		const claim = ui.task("claim", "claiming ios");
		advance(1300);
		claim.ok("UDID-1");
		ui.task("app", "building");
		await settle();
		const text = (await screen()).join("\n");
		expect(text).toContain("✓ claiming ios");
		expect(text).toContain("1.3s");
		expect(text).toContain("▶ building");
		expect(text).toContain("· metro");
		await ui.close();
	});

	test("ctx.err lands in the running task's row; selecting it shows the lines", async () => {
		const { ui, stdin, screen } = setup();
		ui.task("claim", "claiming").ok();
		ui.task("app", "building");
		ui.ctx.err("compiling 1/3");
		ui.ctx.out("compiling 2/3");
		await settle();
		const text = (await screen()).join("\n");
		expect(text).toContain("compiling 1/3");
		expect(text).toContain("compiling 2/3");
		stdin.press("k");
		stdin.press("k");
		await settle();
		const claim = (await screen()).join("\n");
		expect(claim.split("\n")[1]).toContain("› ✓ claiming");
		expect(claim).not.toContain("compiling 2/3");
		await ui.close();
	});

	test("the handle's log targets its own row even when another is running", async () => {
		const { ui, stdin, screen } = setup();
		const claim = ui.task("claim", "claiming");
		ui.task("app", "building");
		claim.log("claim detail");
		stdin.press("k");
		stdin.press("k");
		await settle();
		expect((await screen()).join("\n")).toContain("claim detail");
		await ui.close();
	});

	test("a failed task is red-marked with its error", async () => {
		const { ui, screen } = setup();
		ui.task("app", "building").fail("xcodebuild exited 65");
		await settle();
		const text = (await screen()).join("\n");
		expect(text).toContain("✗ building");
		expect(text).toContain("xcodebuild exited 65");
		await ui.close();
	});

	test("the spinner of withSpinner feeds the running task", async () => {
		const { ui, screen } = setup();
		ui.task("app", "building");
		const spinner = ui.ctx.ui.spinner("preparing the ios dev build…");
		spinner.log("fingerprint abc");
		spinner.update("installing…");
		await settle();
		const text = (await screen()).join("\n");
		expect(text).toContain("▶ installing…");
		expect(text).toContain("preparing the ios dev build…");
		expect(text).toContain("fingerprint abc");
		await ui.close();
	});

	test("ready fills the header and the session row", async () => {
		const { ui, screen } = setup();
		ui.ready(READY);
		await settle();
		const rows = await screen();
		expect(rows[0]).toContain("warden dev · ios · example");
		expect(rows[0]).toContain("warden-iphone-17-5 · :8101 · http://localhost:8101");
		const text = rows.join("\n");
		expect(text).toContain("▶ session");
		expect(text).toContain("holding the device and port");
		await ui.close();
	});

	test("lines after ready go to the session row", async () => {
		const { ui, screen } = setup();
		ui.task("metro", "metro").ok();
		ui.ready(READY);
		ui.ctx.err("metro says hi");
		await settle();
		expect((await screen()).join("\n")).toContain("metro says hi");
		await ui.close();
	});

	test("q calls the quit handler once and shows stopping…", async () => {
		const { ui, stdin, screen } = setup();
		let calls = 0;
		ui.onQuit(() => {
			calls++;
		});
		ui.ready(READY);
		stdin.press("q");
		stdin.press("q");
		stdin.press("\x03");
		await settle();
		expect(calls).toBe(1);
		const text = (await screen()).join("\n");
		expect(text).toContain("▶ stopping…");
		expect(text).toContain("stopping… waiting for Metro");
		await ui.close();
	});

	test("Ctrl-C quits the same way", async () => {
		const { ui, stdin } = setup();
		let calls = 0;
		ui.onQuit(() => {
			calls++;
		});
		stdin.press("\x03");
		expect(calls).toBe(1);
		await ui.close();
	});

	test("? shows the help overlay and Esc closes it", async () => {
		const { ui, stdin, screen, stdout } = setup();
		stdin.press("?");
		await settle();
		expect((await screen()).join("\n")).toContain("┌ keys");
		stdin.press("\x1b");
		await Bun.sleep(60);
		stdout.clear();
		await settle();
		expect((await screen()).join("\n")).not.toContain("┌ keys");
		await ui.close();
	});

	test("an unbuilt action key logs 'not available yet'", async () => {
		const { ui, stdin, screen } = setup();
		stdin.press("r");
		await settle();
		expect((await screen()).join("\n")).toContain("reload app: not available yet");
		await ui.close();
	});

	test("events inside one frame coalesce into one write", async () => {
		const { ui, stdout } = setup();
		await settle();
		stdout.clear();
		for (let i = 0; i < 50; i++) ui.ctx.err(`line ${i}`);
		await settle();
		expect(stdout.writes.length).toBe(1);
		await ui.close();
	});

	test("every frame write stays inside the alt screen and the terminal rows", async () => {
		const { ui, stdout } = setup();
		ui.task("claim", "claiming");
		ui.ctx.err("x".repeat(500));
		await settle();
		const rows = [...stdout.all().matchAll(new RegExp(`${String.fromCharCode(27)}\\[(\\d+);1H`, "g"))].map((m) =>
			Number(m[1])
		);
		expect(Math.max(...rows)).toBeLessThanOrEqual(24);
		expect(stdout.all().indexOf("\x1b[?1049h")).toBe(0);
		await ui.close();
		expect(stdout.all().endsWith("\x1b[?1049l")).toBe(true);
	});

	test("a terminal resize re-lays the dashboard out", async () => {
		const { ui, stdout, process } = setup();
		await settle();
		stdout.clear();
		stdout.resize(120, 40);
		process.emit("SIGWINCH");
		await settle();
		const rows = await replay(stdout.all(), 120, 40);
		expect(rows[0]).toContain("hud off");
		await ui.close();
	});

	test("too small shows a single line", async () => {
		const { ui, stdout, process } = setup();
		await settle();
		stdout.clear();
		stdout.resize(40, 10);
		process.emit("SIGWINCH");
		await settle();
		const rows = await replay(stdout.all(), 40, 10);
		expect(rows[0]).toContain("terminal too small");
		expect(rows.slice(1).map((r) => r.trim())).toEqual(Array(9).fill(""));
		await ui.close();
	});

	test("Ctrl-L repaints every row", async () => {
		const { ui, stdin, stdout } = setup();
		await settle();
		stdout.clear();
		stdin.press("\x0c");
		await settle();
		expect(stdout.all()).toContain("\x1b[2J");
		expect(stdout.all()).toContain("\x1b[24;1H");
		await ui.close();
	});

	test("metro is a PTY mode: size follows the pane, chunks are kept raw, exit is noted", async () => {
		const { ui, stdin, screen } = setup();
		const { metro } = ui;
		if (metro.kind !== "pty") throw new Error("expected pty");
		expect(metro.size()).toEqual({ cols: 80 - 26 - 3, rows: 22 });
		const chunk = new Uint8Array([0xe2, 0x96]);
		metro.onData(chunk);
		expect(ui.metroChunks()).toEqual([chunk]);
		let resolveExit: (code: number) => void = () => undefined;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const written: Array<string | Uint8Array> = [];
		metro.attach({ write: (d) => written.push(d), resize: () => undefined }, exited);
		ui.metroTerminal()?.write("r");
		expect(written).toEqual(["r"]);
		resolveExit(3);
		for (let i = 0; i < 3; i++) stdin.press("j");
		await settle();
		const text = (await screen()).join("\n");
		expect(text).toContain("Metro output appears here");
		expect(text).toContain("metro exited (code 3)");
		await ui.close();
	});
});
