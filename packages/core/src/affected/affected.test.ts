import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { computeAffected, findSuite } from "./affected";
import { makeSuiteRepo } from "./fixture.testing";

const SNAPSHOT = /^[0-9a-f]{40}-[0-9a-f]{16}\.json$/;

let dir: string;
let write: (path: string, text: string) => void;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
const cleanup: string[] = [];
afterEach(() => {
	for (const path of [dir, ...cleanup.splice(0)]) rmSync(path, { recursive: true, force: true });
});

describe("computeAffected", () => {
	test("git changes vs base → selection for the suite's platform; imports cached to disk", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const cacheDir = join(dir, ".cache");
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), cacheDir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite.name).toBe("mobile");
		expect(res.data.base).toBe("main");
		expect(res.data.changes).toEqual([{ path: "src/settings/form.tsx", status: "modified" }]);
		expect(res.data.selections.map((s) => s.platform)).toEqual(["ios"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["settings"]);
		const cached = readdirSync(cacheDir);
		expect(cached).toHaveLength(2);
		expect(cached.filter((f) => SNAPSHOT.test(f))).toHaveLength(1);
	});

	test("the same repo state again reads the graph snapshot: no worker runs, same selection", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const cacheDir = mkdtempSync(join(tmpdir(), "warden-affected-cache-"));
		cleanup.push(cacheDir);
		const workers: string[][] = [];
		const exec: Exec = (cmd, opts) => {
			if (cmd[0] !== "git") workers.push([...cmd]);
			return bunExec(cmd, opts);
		};
		const first = await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		const again = await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		if (!first.success || !again.success) throw new Error("computeAffected failed");
		expect(workers).toHaveLength(1);
		expect(again.data.selections).toEqual(first.data.selections);
		expect(again.data.warnings).toEqual([]);
		write("src/settings/form.tsx", "export const changed = 2;\n");
		await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		expect(workers).toHaveLength(2);
	});

	test("--files instead of git, relative to cwd", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), files: ["chat/lazy.tsx"] });
		if (!res.success) throw new Error(res.error);
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["chats"]);
	});

	test("unknown suite", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: dir, suite: "web" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain('no e2e suite "web"');
	});

	test("suite.headless: the suite's own, else the top-level default", async () => {
		const top = await makeSuiteRepo({}, { headless: true });
		const own = await makeSuiteRepo({ headless: false }, { headless: true });
		const none = await makeSuiteRepo();
		try {
			const [a, b, c] = await Promise.all([top, own, none].map((r) => findSuite(bunExec, r.dir)));
			expect(a?.success && a.data.headless).toBe(true);
			expect(b?.success && b.data.headless).toBe(false);
			expect(c?.success && c.data.headless).toBeUndefined();
		} finally {
			for (const r of [top, own, none]) rmSync(r.dir, { recursive: true, force: true });
		}
	});
});
