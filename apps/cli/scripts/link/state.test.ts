import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { devShim } from "../../src/commands/install";
import { type LinkPaths, linkPaths, restoreLink, shimTarget, snapshotLink, writeShim } from "./state";

let home: string;
let paths: LinkPaths;
const TREE = "/repo/apps/cli/src/cli.ts";
const OTHER = "/other/apps/cli/src/cli.ts";

const link = (cliPath: string) => {
	snapshotLink(paths);
	writeShim(paths, cliPath);
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-link-"));
	paths = linkPaths(home);
	mkdirSync(dirname(paths.bin), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("linkPaths", () => {
	test("is the binary the hooks call, with the snapshot beside it", () => {
		const resolved = linkPaths("/home/me");
		expect(resolved.bin).toBe("/home/me/.local/bin/warden");
		expect(dirname(resolved.stateFile)).toBe("/home/me/.local/bin");
		expect(dirname(resolved.backup)).toBe("/home/me/.local/bin");
	});
});

describe("writeShim", () => {
	test("writes the shim `warden install --shim` writes, executable", () => {
		writeShim(paths, TREE);
		expect(readFileSync(paths.bin, "utf8")).toBe(devShim(TREE));
		expect(statSync(paths.bin).mode & 0o777).toBe(0o755);
		expect(shimTarget(paths.bin)).toBe(TREE);
	});

	test("creates ~/.local/bin when it is missing", () => {
		rmSync(dirname(paths.bin), { recursive: true });
		link(TREE);
		expect(shimTarget(paths.bin)).toBe(TREE);
	});
});

describe("shimTarget", () => {
	test("is undefined for anything that is not a source shim", () => {
		expect(shimTarget(paths.bin)).toBeUndefined();
		writeFileSync(paths.bin, "\u0000compiled");
		expect(shimTarget(paths.bin)).toBeUndefined();
		rmSync(paths.bin);
		symlinkSync("/somewhere/warden", paths.bin);
		expect(shimTarget(paths.bin)).toBeUndefined();
	});
});

describe("snapshotLink then restoreLink", () => {
	test("nothing installed before: the shim is removed again", () => {
		link(TREE);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "absent" });
		expect(existsSync(paths.bin)).toBe(false);
		expect(existsSync(paths.stateFile)).toBe(false);
	});

	test("an installed binary is set aside and put back, still executable", () => {
		writeFileSync(paths.bin, "\u0000compiled", { mode: 0o755 });

		snapshotLink(paths);
		expect(existsSync(paths.bin)).toBe(false);
		writeShim(paths, TREE);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "moved" });
		expect(readFileSync(paths.bin, "utf8")).toBe("\u0000compiled");
		expect(statSync(paths.bin).mode & 0o777).toBe(0o755);
		expect(existsSync(paths.backup)).toBe(false);
	});

	test("a symlink comes back with the same target", () => {
		symlinkSync("/somewhere/warden", paths.bin);
		link(TREE);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "symlink" });
		expect(readlinkSync(paths.bin)).toBe("/somewhere/warden");
	});

	test("another worktree's shim comes back", () => {
		writeShim(paths, OTHER);
		link(TREE);
		restoreLink(paths, TREE);

		expect(shimTarget(paths.bin)).toBe(OTHER);
	});

	test("linking twice, or from a second worktree, keeps the first snapshot", () => {
		writeFileSync(paths.bin, "\u0000compiled", { mode: 0o755 });
		link(TREE);
		link(OTHER);
		expect(shimTarget(paths.bin)).toBe(OTHER);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "moved" });
		expect(readFileSync(paths.bin, "utf8")).toBe("\u0000compiled");
	});
});

describe("restoreLink without a clean slate", () => {
	test("a real install made since the link is left alone, and the snapshot dropped", () => {
		writeFileSync(paths.bin, "\u0000old", { mode: 0o755 });
		link(TREE);
		rmSync(paths.bin);
		writeFileSync(paths.bin, "\u0000new", { mode: 0o755 });

		expect(restoreLink(paths, TREE)).toEqual({ kind: "replaced" });
		expect(readFileSync(paths.bin, "utf8")).toBe("\u0000new");
		expect(existsSync(paths.stateFile)).toBe(false);
		expect(existsSync(paths.backup)).toBe(false);
	});

	test("the shim deleted since the link: the snapshot is still restored", () => {
		writeFileSync(paths.bin, "\u0000old", { mode: 0o755 });
		link(TREE);
		rmSync(paths.bin);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "moved" });
		expect(readFileSync(paths.bin, "utf8")).toBe("\u0000old");
	});

	test("no snapshot, shim to this tree (`install --shim`): the shim is removed", () => {
		writeShim(paths, TREE);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "restored", was: "absent" });
		expect(existsSync(paths.bin)).toBe(false);
	});

	test("no snapshot, shim to another tree: nothing is touched", () => {
		writeShim(paths, OTHER);

		expect(restoreLink(paths, TREE)).toEqual({ kind: "not-linked" });
		expect(shimTarget(paths.bin)).toBe(OTHER);
	});

	test("no snapshot, an installed binary: nothing is touched", () => {
		writeFileSync(paths.bin, "\u0000compiled");

		expect(restoreLink(paths, TREE)).toEqual({ kind: "not-linked" });
		expect(readFileSync(paths.bin, "utf8")).toBe("\u0000compiled");
	});

	test("no snapshot, nothing installed", () => {
		expect(restoreLink(paths, TREE)).toEqual({ kind: "not-linked" });
	});
});
