import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeSuiteRepo } from "./fixture.testing";

function gitConfig(dir: string, key: string): string {
	return Bun.spawnSync(["git", "config", "--get", key], { cwd: dir }).stdout.toString().trim();
}

describe("makeSuiteRepo", () => {
	test("auto-maintenance is off, so no maintenance.lock appears while the repo is copied", async () => {
		const { dir } = await makeSuiteRepo();
		try {
			expect(gitConfig(dir, "maintenance.auto")).toBe("false");
			expect(gitConfig(dir, "gc.auto")).toBe("0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
