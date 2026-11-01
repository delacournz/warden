import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeMetros, fakePages } from "@delacour/warden-devtools/testing/devtools";
import { programRunner } from "../command";
import { cliTesting, type TestContext } from "../testing";
import { COMMANDS } from "./registry";
import { UiCollectCommand } from "./ui-collect";

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
		const page = fakePages.create();
		const fake = fakeMetros.start({ respond: (request, connection) => page.respond(request, connection) });
		cleanup.push(() => fake.stop());
		const dir = out();
		ctx = cliTesting.testContext(["--metro", fake.url, "--out", dir, "--idle-ms", "60"]);
		const code = await new UiCollectCommand().definition().run(ctx);
		expect(code).toBe(0);
		expect(existsSync(join(dir, "console.jsonl"))).toBe(true);
		expect(readFileSync(join(dir, "network.jsonl"), "utf8")).toBe("");
		expect(ctx.stderr.join("\n")).toContain("ended (idle)");
	});

	test("an abort ends it with 0", async () => {
		const fake = fakeMetros.start();
		cleanup.push(() => fake.stop());
		const controller = new AbortController();
		ctx = cliTesting.testContext(["--metro", fake.url, "--out", out(), "--idle-ms", "60000"]);
		const running = new UiCollectCommand({ signal: controller.signal }).definition().run(ctx);
		await Bun.sleep(100);
		controller.abort();
		expect(await running).toBe(0);
		expect(ctx.stderr.join("\n")).toContain("ended (aborted)");
	});

	test("no dev client is exit 3", async () => {
		ctx = cliTesting.testContext(["--metro", "http://127.0.0.1:1", "--out", out()]);
		expect(await new UiCollectCommand().definition().run(ctx)).toBe(3);
	});

	test("missing arguments are exit 1", async () => {
		ctx = cliTesting.testContext(["--out", out()]);
		expect(await new UiCollectCommand().definition().run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("--metro");
	});

	test("it is registered but hidden from --help", async () => {
		ctx = cliTesting.testContext([]);
		expect(COMMANDS.map((c) => c.name)).toContain("ui-collect");
		await programRunner.runLazy(COMMANDS, ["--help"], ctx);
		const help = ctx.stdout.join("\n");
		expect(help).toContain("ui ");
		expect(help).not.toContain("ui-collect");
	});
});
