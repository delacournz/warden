import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function loadedBy(args: string[]): Promise<string[]> {
	const proc = Bun.spawn(["bun", "--preload", preload, resolve(SRC, "cli.ts"), ...args], {
		env: { ...process.env, WARDEN_HOME: join(scratch, "home"), NO_COLOR: "1", CI: "1" },
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
