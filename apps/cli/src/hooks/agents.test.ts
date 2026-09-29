import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgents, onPath } from "./agents";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function sandbox(): { home: string; bin: string } {
	dir = mkdtempSync(join(tmpdir(), "warden-agents-"));
	const home = join(dir, "home");
	const bin = join(dir, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	return { home, bin };
}

function exe(bin: string, name: string, mode = 0o755): void {
	writeFileSync(join(bin, name), "#!/bin/sh\n");
	chmodSync(join(bin, name), mode);
}

describe("onPath", () => {
	test("finds executables only, in PATH order", () => {
		const { bin } = sandbox();
		exe(bin, "codex");
		exe(bin, "claude", 0o644);
		expect(onPath({ PATH: `/nonexistent:${bin}` }, "codex")).toBe(true);
		expect(onPath({ PATH: bin }, "claude")).toBe(false);
		expect(onPath({}, "codex")).toBe(false);
	});
});

describe("detectAgents", () => {
	test("nothing present → none", () => {
		const { home, bin } = sandbox();
		expect(detectAgents({ HOME: home, PATH: bin })).toEqual([]);
	});

	test("~/.claude dir → claude", () => {
		const { home, bin } = sandbox();
		mkdirSync(join(home, ".claude"));
		expect(detectAgents({ HOME: home, PATH: bin })).toEqual(["claude"]);
	});

	test("~/.codex dir → codex", () => {
		const { home, bin } = sandbox();
		mkdirSync(join(home, ".codex"));
		expect(detectAgents({ HOME: home, PATH: bin })).toEqual(["codex"]);
	});

	test("$CODEX_HOME dir → codex (even without ~/.codex)", () => {
		const { home, bin } = sandbox();
		const codexHome = join(home, "custom-codex");
		mkdirSync(codexHome);
		expect(detectAgents({ HOME: home, PATH: bin, CODEX_HOME: codexHome })).toEqual(["codex"]);
	});

	test("binaries on PATH → both", () => {
		const { home, bin } = sandbox();
		exe(bin, "claude");
		exe(bin, "codex");
		expect(detectAgents({ HOME: home, PATH: bin })).toEqual(["claude", "codex"]);
	});

	test("no HOME still detects via PATH", () => {
		const { bin } = sandbox();
		exe(bin, "codex");
		expect(detectAgents({ PATH: bin })).toEqual(["codex"]);
	});
});
