import { describe, expect, test } from "bun:test";
import type { Exec } from "../exec";
import { combineKey, jsInputsHash, matchJsInputs } from "./js-inputs";

/** `git ls-files -z` host over a file map: `-z` output, NUL separated. */
function host(files: Record<string, string>, ls = Object.keys(files)) {
	const calls: Array<{ cmd: string; cwd?: string }> = [];
	const exec: Exec = async (cmd, opts) => {
		calls.push({ cmd: cmd.join(" "), ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
		return { exitCode: 0, stdout: ls.join("\0"), stderr: "" };
	};
	const readFile = async (path: string): Promise<Uint8Array | undefined> => {
		const body = files[path.replace("/repo/app/", "")];
		return body === undefined ? undefined : new TextEncoder().encode(body);
	};
	return { exec, readFile, calls };
}

describe("matchJsInputs", () => {
	test("globs relative to the project root", () => {
		const paths = ["src/a.ts", "src/deep/b.tsx", "app.json", "ios/Podfile", "README.md"];
		expect(matchJsInputs(paths, ["src/**", "app.json"])).toEqual(["src/a.ts", "src/deep/b.tsx", "app.json"]);
	});
});

describe("jsInputsHash", () => {
	const inputs = ["src/**"];

	test("lists tracked + untracked-not-ignored files in the project root", async () => {
		const h = host({ "src/a.ts": "a" });
		await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
		expect(h.calls).toEqual([{ cmd: "git ls-files -z --cached --others --exclude-standard -- .", cwd: "/repo/app" }]);
	});

	test("same content → same hash; any matched file change → new hash; order irrelevant", async () => {
		const a = host({ "src/a.ts": "a", "src/b.ts": "b" });
		const b = host({ "src/a.ts": "a", "src/b.ts": "b" }, ["src/b.ts", "src/a.ts"]);
		const c = host({ "src/a.ts": "a", "src/b.ts": "CHANGED" });
		const hash = async (h: ReturnType<typeof host>) => {
			const res = await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
			if (!res.success) throw new Error(res.error);
			return res.data;
		};
		expect(await hash(a)).toBe(await hash(b));
		expect(await hash(a)).not.toBe(await hash(c));
	});

	test("files outside the globs don't move the hash", async () => {
		const a = host({ "src/a.ts": "a", "docs/x.md": "1" });
		const b = host({ "src/a.ts": "a", "docs/x.md": "2" });
		const run = async (h: ReturnType<typeof host>) =>
			jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
		expect(await run(a)).toEqual(await run(b));
	});

	test("renaming a file changes the hash even with equal content", async () => {
		const a = host({ "src/a.ts": "x" });
		const b = host({ "src/b.ts": "x" });
		const run = async (h: ReturnType<typeof host>) =>
			jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
		const [ra, rb] = [await run(a), await run(b)];
		expect(ra.success && rb.success && ra.data !== rb.data).toBe(true);
	});

	test("a tracked file deleted from disk is skipped, not an error", async () => {
		const h = host({ "src/a.ts": "a" }, ["src/a.ts", "src/gone.ts"]);
		const res = await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(true);
	});

	test("no file matches → error (the globs are wrong, not an empty hash)", async () => {
		const h = host({ "ios/Podfile": "p" });
		const res = await jsInputsHash({ exec: h.exec, readFile: h.readFile, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint.jsInputs");
	});

	test("git failure → error", async () => {
		const exec: Exec = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" });
		const res = await jsInputsHash({ exec, readFile: async () => undefined, root: "/repo/app", jsInputs: inputs });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("not a git repository");
	});
});

describe("combineKey", () => {
	test("deterministic, depends on both halves, hex of the native hash's length class", () => {
		const k = combineKey("native1", "js1");
		expect(k).toBe(combineKey("native1", "js1"));
		expect(k).not.toBe(combineKey("native2", "js1"));
		expect(k).not.toBe(combineKey("native1", "js2"));
		expect(k).toMatch(/^[0-9a-f]{40}$/);
	});
});
