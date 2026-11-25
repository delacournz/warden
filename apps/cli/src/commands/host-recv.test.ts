import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packTree, treeHash } from "../hosts/upload";
import { type TestContext, testContext } from "../testing";
import { createHostRecvCommand } from "./host-recv";

const ctxs: TestContext[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const c of ctxs.splice(0)) c.cleanup();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("warden __host-recv", () => {
	test("--check, then receive from stdin, then --check finds it", async () => {
		const src = mkdtempSync(join(tmpdir(), "warden-recv-"));
		dirs.push(src);
		mkdirSync(join(src, "A.app"));
		writeFileSync(join(src, "A.app", "A"), "a");
		const hash = await treeHash(join(src, "A.app"));
		const tar = await packTree(join(src, "A.app"), src);
		const run = async (argv: string[]) => {
			const ctx = testContext(argv);
			ctxs.push(ctx);
			ctx.env.WARDEN_HOME = join(src, "home");
			const code = await createHostRecvCommand({ input: () => Bun.file(tar).stream() }).run(ctx);
			return { code, out: JSON.parse(ctx.stdout.join("")) };
		};
		expect((await run(["--hash", hash, "--name", "A.app", "--check", "--json"])).out.present).toBe(false);
		const got = await run(["--hash", hash, "--name", "A.app", "--json"]);
		expect(got.code).toBe(0);
		expect(got.out.path).toBe(join(src, "home", "uploads", hash, "A.app"));
		expect((await run(["--hash", hash, "--name", "A.app", "--check", "--json"])).out.present).toBe(true);
	});

	test("a bad hash or name exits 1", async () => {
		const ctx = testContext(["--hash", "nope", "--name", "../x", "--json"]);
		ctxs.push(ctx);
		expect(await createHostRecvCommand().run(ctx)).toBe(1);
	});
});
