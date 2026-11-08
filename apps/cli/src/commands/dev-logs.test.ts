import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDevSession } from "../dev-session";
import { BUNDLE_OK, BUNDLE_SYNTAX_ERROR, RUNTIME_LOGS } from "../dev-tui/metro-log.testing";
import { type TestContext, testContext } from "../testing";
import { createDevCommand, defaultDevDeps } from "./dev";
import { type DevLogsDeps, devLogs } from "./dev-logs";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const home = (c: TestContext) => c.env.WARDEN_HOME ?? "";

/** A context whose WARDEN_HOME holds one dev session (this process's pid, so it is alive) and a metro.log. */
function withSession(log: string | undefined, argv: string[] = []): TestContext {
	const c = testContext(argv);
	ctx = c;
	const logDir = join(home(c), "dev", "L1");
	mkdirSync(logDir, { recursive: true });
	if (log !== undefined) writeFileSync(join(logDir, "metro.log"), log);
	writeDevSession(c.env, {
		version: 1,
		leaseId: "L1",
		pid: process.pid,
		platform: "ios",
		deviceId: "UDID-1",
		port: 8101,
		metroUrl: "http://localhost:8101",
		logDir,
		projectRoot: "/work/example",
		startedAt: "2026-10-27T00:00:00.000Z",
	});
	return c;
}

const deps = (overrides: Partial<DevLogsDeps> = {}): DevLogsDeps => ({
	isAlive: () => true,
	sleep: async () => {},
	interrupt: () => () => {},
	...overrides,
});

describe("warden dev logs", () => {
	test("prints each entry's text", async () => {
		const c = withSession(BUNDLE_OK + BUNDLE_SYNTAX_ERROR);
		expect(await devLogs(c, {}, deps())).toBe(0);
		expect(c.stdout.join("\n")).toContain("Bundled 1432ms");
		expect(c.stdout.join("\n")).toContain("Unexpected token");
	});

	test("--json prints one JSON object per line", async () => {
		const c = withSession(BUNDLE_OK + BUNDLE_SYNTAX_ERROR);
		expect(await devLogs(c, { json: true, kind: "bundle_failed" }, deps())).toBe(0);
		expect(c.stdout).toHaveLength(1);
		const parsed = JSON.parse(c.stdout[0] ?? "");
		expect(parsed).toMatchObject({ kind: "bundle_failed", line: 12, col: 20 });
	});

	test("--tail, --grep and --kind narrow", async () => {
		const c = withSession(BUNDLE_OK + BUNDLE_SYNTAX_ERROR + RUNTIME_LOGS);
		await devLogs(c, { json: true, tail: "1" }, deps());
		expect(c.stdout).toHaveLength(1);
		c.stdout.length = 0;
		await devLogs(c, { json: true, grep: "fast refresh" }, deps());
		expect(c.stdout.map((l) => JSON.parse(l).kind)).toEqual(["info"]);
		c.stdout.length = 0;
		await devLogs(c, { json: true, kind: "error,warn" }, deps());
		expect(c.stdout.map((l) => JSON.parse(l).kind)).toEqual(["warn", "error"]);
	});

	test("bad flags are reported, exit 1", async () => {
		const c = withSession(BUNDLE_OK);
		expect(await devLogs(c, { since: "soon" }, deps())).toBe(1);
		expect(await devLogs(c, { tail: "-3" }, deps())).toBe(1);
		expect(await devLogs(c, { kind: "nope" }, deps())).toBe(1);
		expect(await devLogs(c, { grep: "(" }, deps())).toBe(1);
		expect(c.stderr.join("\n")).toContain("invalid --since");
	});

	test("--since skips a log last written before it", async () => {
		const c = withSession(BUNDLE_OK);
		c.now = () => Date.now() + 3_600_000;
		expect(await devLogs(c, { since: "5m" }, deps())).toBe(0);
		expect(c.stdout).toEqual([]);
	});

	test("no dev session: code in --json, message otherwise, exit 1", async () => {
		const c = testContext([]);
		ctx = c;
		expect(await devLogs(c, { json: true }, deps())).toBe(1);
		expect(JSON.parse(c.stdout[0] ?? "").error.code).toBe("no_dev_session");
		expect(await devLogs(c, {}, deps())).toBe(1);
		expect(c.stderr.join("\n")).toContain("no running `warden dev` session");
	});

	test("no metro.log: metro_log_unavailable with the TUI hint", async () => {
		const c = withSession(undefined);
		expect(await devLogs(c, { json: true }, deps())).toBe(1);
		const { ok, command, error } = JSON.parse(c.stdout[0] ?? "");
		expect({ ok, command }).toEqual({ ok: false, command: "dev logs" });
		expect(error.code).toBe("metro_log_unavailable");
		expect(error.hint).toContain("warden dev");
	});

	test("--follow prints entries appended later until interrupted", async () => {
		const c = withSession(BUNDLE_OK);
		const path = join(home(c), "dev", "L1", "metro.log");
		let abort: () => void = () => {};
		let ticks = 0;
		const code = await devLogs(
			c,
			{ follow: true, json: true },
			deps({
				interrupt: (fn) => {
					abort = fn;
					return () => {};
				},
				sleep: async () => {
					ticks++;
					if (ticks === 1) appendFileSync(path, RUNTIME_LOGS);
					if (ticks === 3) abort();
				},
			})
		);
		expect(code).toBe(0);
		const kinds = c.stdout.map((l) => JSON.parse(l).kind);
		expect(kinds.slice(0, 2)).toEqual(["bundle_done", "bundle_done"]);
		expect(kinds.slice(2)).toEqual(["warn", "error", "info", "info", "info"]);
		expect(JSON.parse(c.stdout[2] ?? "").ts).toBe(c.now());
	});
});

describe("warden dev logs routing", () => {
	test("`dev logs` runs the subcommand and parses its flags", async () => {
		const c = withSession(BUNDLE_OK + BUNDLE_SYNTAX_ERROR, [
			"logs",
			"--json",
			"--kind",
			"bundle_failed",
			"--tail",
			"5",
		]);
		const code = await createDevCommand(defaultDevDeps).run(c);
		expect(code).toBe(0);
		expect(c.stdout).toHaveLength(1);
		expect(JSON.parse(c.stdout[0] ?? "").kind).toBe("bundle_failed");
	});

	test("--udid selects the session", async () => {
		const c = withSession(BUNDLE_OK, ["logs", "--udid", "UDID-9"]);
		expect(await createDevCommand(defaultDevDeps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("no running `warden dev` session");
	});
});
