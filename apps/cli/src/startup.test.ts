import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SRC = import.meta.dir;
const MARKER = "LOADED:";

/**
 * Cold-start guard. Runs the CLI in a child `bun` with a preload that prints every module the process has
 * loaded (`require.cache` lists ESM modules too) when it exits, so we can assert what a command does NOT pull in.
 */
let scratch = "";
let preload = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "warden-startup-"));
	preload = join(scratch, "loaded.ts");
	writeFileSync(
		preload,
		`process.on("exit", () => console.error("${MARKER}" + JSON.stringify(Object.keys(require.cache))));\n`
	);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function loadedBy(args: string[], home: string = join(scratch, "home")): Promise<string[]> {
	const proc = Bun.spawn(["bun", "--preload", preload, resolve(SRC, "cli.ts"), ...args], {
		env: { ...process.env, WARDEN_HOME: home, NO_COLOR: "1", CI: "1" },
		stdout: "ignore",
		stderr: "pipe",
		stdin: "ignore",
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	const line = stderr.split("\n").find((l) => l.startsWith(MARKER));
	if (!line) throw new Error(`no module list from \`warden ${args.join(" ")}\`:\n${stderr}`);
	return (JSON.parse(line.slice(MARKER.length)) as string[]).map((f) => f.replaceAll("\\", "/"));
}

const has = (files: string[], needle: string) => files.some((f) => f.includes(needle));
const commandModules = (files: string[]) =>
	files
		.filter((f) => /\/apps\/cli\/src\/commands\/[^/]+\.ts$/.test(f))
		.map((f) => f.slice(f.lastIndexOf("/") + 1))
		.filter((f) => f !== "registry.ts");

describe("cold start", () => {
	test("`warden version` imports its own command and no UI libraries, zod or e2e driver", async () => {
		const files = await loadedBy(["version"]);
		expect(commandModules(files)).toEqual(["version.ts"]);
		for (const heavy of ["/node_modules/ora/", "/node_modules/@clack/", "/node_modules/zod/", "/packages/e2e/"])
			expect(has(files, heavy)).toBe(false);
	});

	test("only the dispatched command's module loads", async () => {
		expect(commandModules(await loadedBy(["heartbeat", "--help"]))).toEqual(["heartbeat.ts"]);
		expect(commandModules(await loadedBy(["claim", "--help"]))).toEqual(["claim.ts"]);
	});

	test("commands that are not `perf` never load the perf package", async () => {
		for (const args of [["version"], ["heartbeat", "--help"], ["claim", "--help"], ["ui", "--help"]]) {
			expect(has(await loadedBy(args), "/packages/perf/")).toBe(false);
		}
	});

	test("`warden --help` still loads every command (argument placeholders come from registration)", async () => {
		expect(commandModules(await loadedBy(["--help"])).length).toBeGreaterThan(20);
	});

	test("commands that never show a spinner or prompt don't load ora or clack", async () => {
		for (const args of [
			["ls", "--json"],
			["heartbeat", "--help"],
			["claim", "--help"],
		]) {
			const files = await loadedBy(args);
			expect(has(files, "/node_modules/ora/")).toBe(false);
			expect(has(files, "/node_modules/@clack/")).toBe(false);
		}
	});
});

describe("cold start: the viewer is lazy", () => {
	test("`warden view --help` loads its own command only; claim, heartbeat and release never load the viewer", async () => {
		expect(commandModules(await loadedBy(["view", "--help"]))).toEqual(["view.ts"]);
		for (const args of [["claim", "--help"], ["heartbeat"], ["release", "--help"], ["version"]]) {
			expect(loaded(await loadedBy(args), ["/src/remote/viewer.ts", "/src/commands/view.ts"])).toEqual([]);
		}
	});
});

describe("cold start: the commands agents call most", () => {
	const FORBID = [
		"/node_modules/zod/",
		"/node_modules/ora/",
		"/node_modules/@clack/",
		"/packages/e2e/",
		"/node_modules/typescript/",
	];
	/** `--help` where a real call would touch a device or a toolchain; the module graph is the same up to dispatch. */
	const CASES: { args: string[]; forbid: string[] }[] = [
		{ args: ["hook", "pretool"], forbid: FORBID },
		{ args: ["heartbeat"], forbid: FORBID },
		{ args: ["claim", "--help"], forbid: FORBID },
		{ args: ["ls", "--json"], forbid: FORBID },
		{ args: ["devices", "--help"], forbid: FORBID },
		{ args: ["check", "--help"], forbid: FORBID },
		{ args: ["port", "ls", "--json"], forbid: FORBID },
		// run, dev and app parse a config only once called with a project (15-2): zod loads at the parse, not at start
		{ args: ["run", "--help"], forbid: FORBID },
		{ args: ["dev", "--help"], forbid: FORBID },
		{ args: ["app", "--help"], forbid: FORBID },
	];

	for (const { args, forbid } of CASES) {
		test(`\`warden ${args.join(" ")}\` loads none of zod, ora, clack, the e2e package or typescript`, async () => {
			expect(loaded(await loadedBy(args), forbid)).toEqual([]);
		});
	}
});

describe("cold start: the dev dashboard is lazy", () => {
	// dev.ts imports hud.ts for --hud-interval (small, no xterm); the dashboard itself loads only on the TUI path
	const TUI = ["/src/dev-tui/tui.ts", "/src/dev-tui/metro-pane.ts", "/src/dev-tui/render.ts", "/node_modules/@xterm/"];

	for (const args of [
		["version"],
		["claim", "--help"],
		["heartbeat"],
		["gc", "--json"],
		["release", "--help"],
		["ui", "--help"],
		["dev", "--help"],
	]) {
		test(`\`warden ${args.join(" ")}\` loads neither the dashboard nor xterm`, async () => {
			expect(loaded(await loadedBy(args), TUI)).toEqual([]);
		});
	}
});

describe("cold start: gc and release", () => {
	const HEAVY = [
		"/packages/e2e/",
		"/node_modules/zod/",
		"/node_modules/typescript/",
		"/agent-ui/helper.ts",
		"/agent-ui/state.ts",
	];
	const heavyIn = (files: string[]) => HEAVY.filter((needle) => has(files, needle));

	/** A `$WARDEN_HOME` laid out like a machine that has run `warden ui`: a resident helper's record and socket dir. */
	function homeWithHelper(pid: number): string {
		const home = mkdtempSync(join(scratch, "home-"));
		mkdirSync(join(home, "simd"), { recursive: true });
		mkdirSync(join(home, "ui", "UDID-1"), { recursive: true });
		writeFileSync(join(home, "simd", "UDID-1.sock"), "");
		writeFileSync(
			join(home, "ui", "UDID-1", "state.json"),
			JSON.stringify({ generation: 1, helper: { pid, socket: join(home, "simd", "UDID-1.sock") } })
		);
		return home;
	}

	test("`warden gc` imports its own command and none of the e2e driver, zod, typescript or the helper module", async () => {
		const files = await loadedBy(["gc", "--json"]);
		expect(commandModules(files)).toEqual(["gc.ts"]);
		expect(heavyIn(files)).toEqual([]);
	});

	test("`warden gc --quiet` (the detached auto-gc) loads nothing heavy either", async () => {
		expect(heavyIn(await loadedBy(["gc", "--quiet"]))).toEqual([]);
	});

	test("gc with a live helper on record still loads nothing heavy", async () => {
		const home = homeWithHelper(process.pid);
		expect(heavyIn(await loadedBy(["gc", "--json"], home))).toEqual([]);
	});

	test("gc with a dead helper on record sweeps it (and only then loads the helper module)", async () => {
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		const home = homeWithHelper(dead.pid);
		const files = await loadedBy(["gc", "--json"], home);
		expect(has(files, "/agent-ui/helper.ts")).toBe(true);
		const state = JSON.parse(readFileSync(join(home, "ui", "UDID-1", "state.json"), "utf8"));
		expect(state.helper).toBeUndefined();
	});

	test("`warden release` imports its own command and none of the heavy modules", async () => {
		const files = await loadedBy(["release", "--mine", "--json"]);
		expect(commandModules(files).filter((f) => f !== "ls.ts")).toEqual(["release.ts"]);
		expect(heavyIn(files)).toEqual([]);
	});
});

/** What opening a device loads: the iOS and Android drivers and the helper socket client. */
const DRIVERS = [
	"/packages/e2e/src/driver/ios/ios-driver.ts",
	"/packages/e2e/src/driver/ios/simd-client.ts",
	"/packages/e2e/src/driver/android/",
];
const loaded = (files: string[], needles: string[]) => needles.filter((needle) => has(files, needle));

describe("cold start: batch and e2e", () => {
	test("`warden batch` and `warden e2e` register without loading a device driver or the helper lifecycle", async () => {
		for (const args of [
			["batch", "--help"],
			["e2e", "--help"],
		]) {
			const files = await loadedBy(args);
			expect(loaded(files, [...DRIVERS, "/agent-ui/helper.ts"])).toEqual([]);
		}
	});
});

describe("cold start: warden ui", () => {
	/** Implementation modules of the other subcommands: a call loads its own and none of these. */
	const OTHERS = [
		"/agent-ui/authoring-command.ts",
		"/agent-ui/authoring-verify.ts",
		"/agent-ui/record-sink.ts",
		"/agent-ui/devtools-cli.ts",
		"/agent-ui/bench.ts",
		"/agent-ui/video.ts",
		"/agent-ui/controls.ts",
		"/agent-ui/gestures.ts",
		"/agent-ui/ui-driver.ts",
		"/agent-ui/conditions.ts",
		"/agent-ui/conditions-real.ts",
	];
	const without = (needles: string[], skip: string) => needles.filter((needle) => needle !== skip);

	test("`ui --help` and `ui <sub> --help` load registration only: no implementation, no e2e package, no zod", async () => {
		for (const args of [
			["ui", "--help"],
			["ui", "snapshot", "--help"],
			["ui", "press", "--help"],
			["ui", "record", "start", "--help"],
			["ui", "network", "--help"],
			["ui", "network", "log", "--help"],
			["ui", "network", "set", "--help"],
			["ui", "location", "--help"],
		]) {
			const files = await loadedBy(args);
			expect(loaded(files, [...OTHERS, "/packages/e2e/", "/node_modules/zod/", "/agent-ui/helper.ts"])).toEqual([]);
			expect(loaded(files, ["/agent-ui/actions.ts", "/agent-ui/snapshot-command.ts", "/agent-ui/run.ts"])).toEqual([]);
		}
	});

	test("`ui snapshot` without a lease loads its own module, not the other subcommands or any driver", async () => {
		const files = await loadedBy(["ui", "snapshot", "--json"]);
		expect(has(files, "/agent-ui/snapshot-command.ts")).toBe(true);
		expect(loaded(files, [...OTHERS, ...DRIVERS, "/agent-ui/actions.ts", "/agent-ui/query.ts"])).toEqual([]);
	});

	test("`ui press` without a lease loads its own module and no driver", async () => {
		const files = await loadedBy(["ui", "press", "@e1", "--json"]);
		expect(has(files, "/agent-ui/actions.ts")).toBe(true);
		expect(loaded(files, [...OTHERS, ...DRIVERS, "/agent-ui/query.ts"])).toEqual([]);
	});

	test("`ui gesture pinch` without a lease loads gestures.ts and no driver", async () => {
		const files = await loadedBy(["ui", "gesture", "pinch", "@e1", "2", "--json"]);
		expect(has(files, "/agent-ui/gestures.ts")).toBe(true);
		expect(loaded(files, [...without(OTHERS, "/agent-ui/gestures.ts"), ...DRIVERS, "/agent-ui/query.ts"])).toEqual([]);
	});

	test("`ui net` / `ui location` without a lease load conditions.ts, not its real side effects or any driver", async () => {
		for (const args of [
			["ui", "network", "set", "3g", "--json"],
			["ui", "location", "set", "1,2", "--json"],
		]) {
			const files = await loadedBy(args);
			expect(has(files, "/agent-ui/conditions.ts")).toBe(true);
			expect(
				loaded(files, [...without(OTHERS, "/agent-ui/conditions.ts"), ...DRIVERS, "/agent-ui/actions.ts"])
			).toEqual([]);
		}
	});

	test("`ui status` and `ui close` read the helper record without loading a driver", async () => {
		for (const [sub, own] of [
			["status", "/agent-ui/status.ts"],
			["close", "/agent-ui/close.ts"],
		] as const) {
			const files = await loadedBy(["ui", sub, "--json"]);
			expect(has(files, own)).toBe(true);
			expect(loaded(files, [...OTHERS, ...DRIVERS, "/agent-ui/actions.ts", "/agent-ui/snapshot-command.ts"])).toEqual(
				[]
			);
		}
	});

	test("`ui press` and `ui status` load neither the recording journal nor its verify run when nothing is recording", async () => {
		for (const args of [
			["ui", "press", "@e1", "--json"],
			["ui", "status", "--json"],
		]) {
			expect(loaded(await loadedBy(args), ["/agent-ui/record-sink.ts", "/agent-ui/authoring-verify.ts"])).toEqual([]);
		}
	});

	test("`ui record status` loads the authoring module, without the verify run, other subcommands or a driver", async () => {
		const files = await loadedBy(["ui", "record", "status", "--json"]);
		expect(has(files, "/agent-ui/authoring-command.ts")).toBe(true);
		expect(loaded(files, [...without(OTHERS, "/agent-ui/authoring-command.ts"), ...DRIVERS])).toEqual([]);
	});

	test("the devtools subcommands load their own module and no driver", async () => {
		const logs = await loadedBy(["ui", "logs", "--json"]);
		expect(has(logs, "/agent-ui/devtools-cli.ts")).toBe(true);
		expect(loaded(logs, [...without(OTHERS, "/agent-ui/devtools-cli.ts"), ...DRIVERS])).toEqual([]);
		for (const args of [
			["ui", "network", "log", "--json"],
			["ui", "network", "--json"],
		]) {
			const files = await loadedBy(args);
			expect(has(files, "/agent-ui/devtools-cli.ts")).toBe(true);
			expect(loaded(files, [...without(OTHERS, "/agent-ui/devtools-cli.ts"), ...DRIVERS])).toEqual([]);
		}
	});
});

describe("terminal ui", () => {
	/** Imports `ui.ts` in a child process and reports which of ora / clack are loaded after each step. */
	async function uiSteps(): Promise<Record<string, { ora: boolean; clack: boolean }>> {
		const script = join(scratch, "ui-steps.ts");
		writeFileSync(
			script,
			`import { terminalUi } from ${JSON.stringify(resolve(SRC, "ui.ts"))};
const seen = () => {
	const files = Object.keys(require.cache);
	return { ora: files.some((f) => f.includes("/node_modules/ora/")), clack: files.some((f) => f.includes("/node_modules/@clack/")) };
};
const out: Record<string, { ora: boolean; clack: boolean }> = {};
const ui = terminalUi({ CI: "1", NO_COLOR: "1" });
out.built = seen();
ui.spinner("working").stop();
out.spinner = seen();
ui.cancelled("bye");
out.cancelled = seen();
console.log(JSON.stringify(out));
`
		);
		const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
	}

	test("building the ui loads neither ora nor clack; the first spinner loads ora; the first prompt output loads clack", async () => {
		const steps = await uiSteps();
		expect(steps.built).toEqual({ ora: false, clack: false });
		expect(steps.spinner).toEqual({ ora: true, clack: false });
		expect(steps.cancelled).toEqual({ ora: true, clack: true });
	});
});
