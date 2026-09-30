import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeSuiteRepo } from "@warden/core/affected/fixture.testing";
import { bunExec } from "@warden/core/exec";
import { type TestContext, testContext } from "../testing";
import { affectedCommand } from "./affected";

let dir: string;
let write: (path: string, text: string) => void;
let ctx: TestContext | undefined;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; ctx: TestContext }> {
	ctx = testContext(argv, { exec: bunExec });
	ctx.cwd = dir;
	return { code: await affectedCommand.run(ctx), ctx };
}

describe("warden affected", () => {
	test("one flow id per line from the git diff", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		const { code, ctx } = await run([]);
		expect(code).toBe(0);
		expect(ctx.stdout).toEqual(["chats"]);
	});

	test("--explain shows the import chain", async () => {
		const { code, ctx } = await run(["mobile", "--files", "src/chat/lazy.tsx", "--explain"]);
		expect(code).toBe(0);
		const text = ctx.stdout.join("\n");
		expect(text).toContain("ios  1 of 2 flow(s)");
		expect(text).toContain("● chats  required");
		expect(text).toContain("src/app/(app)/chats.tsx → src/chat/list.tsx → src/chat/lazy.tsx");
		expect(text).toContain("skipped: settings");
	});

	test("--required-only, --json", async () => {
		const { ctx } = await run(["--files", "src/settings/form.tsx,src/chat/lazy.tsx", "--required-only", "--json"]);
		const doc = JSON.parse(ctx.stdout.join("\n"));
		expect(doc.suite).toBe("mobile");
		expect(doc.platforms[0].selected.map((f: { id: string }) => f.id)).toEqual(["chats"]);
	});

	test("--strict exits 3 when a change reaches no flow", async () => {
		const { code, ctx } = await run(["--files", "src/unused.ts", "--strict", "--explain"]);
		expect(code).toBe(3);
		expect(ctx.stdout.join("\n")).toContain("reached no flow: src/unused.ts");
	});

	test("bad platform / unknown suite → 1", async () => {
		expect((await run(["--platform", "tv"])).code).toBe(1);
		const { code, ctx } = await run(["web"]);
		expect(code).toBe(1);
		expect(ctx.stderr.join("\n")).toContain('no e2e suite "web"');
	});
});
