import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePage, startFakeMetro } from "@delacour/warden-e2e/devtools/devtools.testing";
import { runLazyProgram } from "../command";
import { type TestContext, testContext } from "../testing";
import { COMMANDS } from "./registry";
import { createUiCollectCommand } from "./ui-collect";

const cleanup: (() => unknown)[] = [];
let ctx: TestContext | undefined;
afterEach(async () => {
	ctx?.cleanup();
	for (const fn of cleanup.splice(0)) await fn();
});

const out = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "warden-collect-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

describe("warden ui-collect", () => {
	test("collects until the app is quiet, then exits 0 leaving both files", async () => {
		const page = fakePage();
		const fake = startFakeMetro({ respond: (request, connection) => page.respond(request, connection) });
		cleanup.push(() => fake.stop());
		const dir = out();
		ctx = testContext(["--metro", fake.url, "--out", dir, "--idle-ms", "60"]);
		const code = await createUiCollectCommand().run(ctx);
		expect(code).toBe(0);
		expect(existsSync(join(dir, "console.jsonl"))).toBe(true);
		expect(readFileSync(join(dir, "network.jsonl"), "utf8")).toBe("");
		expect(ctx.stderr.join("\n")).toContain("ended (idle)");
	});

	test("an abort ends it with 0", async () => {
		const fake = startFakeMetro();
		cleanup.push(() => fake.stop());
		const controller = new AbortController();
		ctx = testContext(["--metro", fake.url, "--out", out(), "--idle-ms", "60000"]);
		const running = createUiCollectCommand({ signal: controller.signal }).run(ctx);
		await Bun.sleep(100);
		controller.abort();
		expect(await running).toBe(0);
		expect(ctx.stderr.join("\n")).toContain("ended (aborted)");
	});

	test("no dev client is exit 3", async () => {
		ctx = testContext(["--metro", "http://127.0.0.1:1", "--out", out()]);
		expect(await createUiCollectCommand().run(ctx)).toBe(3);
	});

	test("missing arguments are exit 1", async () => {
		ctx = testContext(["--out", out()]);
		expect(await createUiCollectCommand().run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("--metro");
	});

	test("it is registered but hidden from --help", async () => {
		ctx = testContext([]);
		expect(COMMANDS.map((c) => c.name)).toContain("ui-collect");
		await runLazyProgram(COMMANDS, ["--help"], ctx);
		const help = ctx.stdout.join("\n");
		expect(help).toContain("ui ");
		expect(help).not.toContain("ui-collect");
	});
});
