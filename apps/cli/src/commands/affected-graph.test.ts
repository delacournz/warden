import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { makeFixtureRepo } from "@delacour/warden-core/affected/fixture.testing";
import { type GraphRequest, parseGraphDoc } from "@delacour/warden-core/affected/graph-snapshot";
import { buildGraphDoc } from "@delacour/warden-core/affected/graph-worker";
import { main } from "../cli";
import { type TestContext, testContext } from "../testing";
import { affectedGraphCommand } from "./affected-graph";
import { COMMANDS } from "./registry";

let dir: string;
let ctx: TestContext | undefined;

beforeEach(() => {
	({ dir } = makeFixtureRepo());
});
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

const request = (): GraphRequest => ({ platform: "ios", repoRoot: dir, entries: [`${dir}/src/app/(app)/chats.tsx`] });

async function run(argv: string[]): Promise<{ code: number; ctx: TestContext }> {
	ctx = testContext(argv);
	return { code: await affectedGraphCommand.run(ctx), ctx };
}

describe("warden __affected-graph", () => {
	test("prints the import graph table for the request, as one JSON line and nothing else", async () => {
		const { code, ctx } = await run([JSON.stringify(request())]);
		expect(code).toBe(0);
		expect(ctx.stderr).toEqual([]);
		expect(ctx.stdout).toHaveLength(1);
		const doc = parseGraphDoc(ctx.stdout[0] ?? "");
		expect(doc).toEqual(await buildGraphDoc(request()));
		expect(doc?.files.some((f) => f.endsWith("packages/ui/src/button.tsx"))).toBe(true);
	});

	test("a request that is not JSON, or not a graph request, is exit 1 with a message and no stdout", async () => {
		for (const bad of ["{ nope", "{}", JSON.stringify({ ...request(), platform: "tv" })]) {
			const { code, ctx } = await run([bad]);
			expect(code).toBe(1);
			expect(ctx.stdout).toEqual([]);
			expect(ctx.stderr.join("\n")).toContain("__affected-graph");
		}
	});

	test("no request is a usage error", async () => {
		expect((await run([])).code).toBe(1);
	});

	test("is hidden: listed in the registry as hidden, absent from `warden --help`", async () => {
		expect(COMMANDS.find((c) => c.name === "__affected-graph")?.hidden).toBe(true);
		let help: TestContext | undefined;
		expect(
			await main(["--help"], (argv) => {
				help = testContext(argv);
				return help;
			})
		).toBe(0);
		expect(help?.stdout.join("\n")).not.toContain("__affected-graph");
		help?.cleanup();
	});

	test("end to end: the real CLI prints a table that parseGraphDoc accepts", async () => {
		const proc = Bun.spawn(
			["bun", resolve(import.meta.dir, "..", "cli.ts"), "__affected-graph", JSON.stringify(request())],
			{
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			}
		);
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(parseGraphDoc(stdout)).toEqual(await buildGraphDoc(request()));
	});
});
