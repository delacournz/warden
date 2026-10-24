import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFromSource, compileArgs, type EmbeddedBuild, runtimeBlobArgs } from "./source-build";

const info: EmbeddedBuild = { channel: "release", version: "1.2.3", builtAt: "2026-10-16T00:00:00.000Z" };

describe("compileArgs", () => {
	const cmd = compileArgs({ entry: "/src/cli.ts", outfile: "/out/warden", info });

	test("compiles the entry to the outfile", () => {
		expect(cmd.slice(0, 3)).toEqual(["bun", "build", "--compile"]);
		expect(cmd).toContain("/src/cli.ts");
		expect(cmd[cmd.indexOf("--outfile") + 1]).toBe("/out/warden");
	});

	test("minifies and ships bytecode with a linked source map: ~4x faster start, readable stack traces", () => {
		expect(cmd).toContain("--minify");
		expect(cmd).toContain("--bytecode");
		expect(cmd).toContain("--sourcemap=linked");
	});

	test("leaves typescript out (28 MB, only `warden affected` uses it, resolved from the analysed project)", () => {
		expect(cmd[cmd.indexOf("--external") + 1]).toBe("typescript");
	});

	test("embeds the build info under DEFINE_KEY", () => {
		const at = cmd.indexOf("--define");
		expect(at).toBeGreaterThan(-1);
		const [key, value] = (cmd[at + 1] ?? "").split(/=(.*)/s);
		expect(key).toBe("__WARDEN_BUILD__");
		expect(JSON.parse(value ?? "")).toEqual(info);
	});

	test("extra files to embed come after the entry", () => {
		const embedded = compileArgs({ entry: "/src/cli.ts", outfile: "/out/w", info, embed: ["/tmp/e2e-runtime.bin"] });
		expect(embedded.indexOf("/tmp/e2e-runtime.bin")).toBe(embedded.indexOf("/src/cli.ts") + 1);
		expect(cmd).not.toContain("/tmp/e2e-runtime.bin");
	});

	test("a cross-compile target is passed through", () => {
		const cross = compileArgs({ entry: "/src/cli.ts", outfile: "/out/w", info, target: "bun-linux-x64" });
		expect(cross).toContain("--target=bun-linux-x64");
		expect(cmd.some((a) => a.startsWith("--target"))).toBe(false);
	});
});

describe("bytecode build", () => {
	/**
	 * `--bytecode` bundles as CommonJS, so one top-level `await` anywhere in the CLI's import graph breaks the
	 * release build (`error: "await" can only be used inside an "async" function`). A child process: `Bun.build`
	 * inside `bun test` mis-resolves workspace files.
	 */
	test("the CLI bundles as CommonJS bytecode (no top-level await in its graph)", async () => {
		const outdir = mkdtempSync(join(tmpdir(), "warden-bytecode-"));
		try {
			const entry = resolve(import.meta.dir, "..", "cli.ts");
			const proc = Bun.spawn(
				["bun", "build", entry, "--target=bun", "--format=cjs", "--bytecode", "--minify", "--outdir", outdir],
				{ stdout: "ignore", stderr: "pipe", stdin: "ignore" }
			);
			const stderr = await new Response(proc.stderr).text();
			expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
		} finally {
			rmSync(outdir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("buildFromSource", () => {
	test("packs the e2e runtime blob next to the outfile, embeds it, and removes it after", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-source-build-"));
		const calls: Array<readonly string[]> = [];
		try {
			const built = await buildFromSource(
				async (cmd) => {
					calls.push(cmd);
					if (cmd[0] === "bun" && cmd[1]?.endsWith("e2e-runtime.ts")) writeFileSync(cmd[3] ?? "", "{}");
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				"/repo",
				"1.2.3",
				join(dir, "warden"),
				() => 0
			);
			expect(built.success).toBe(true);
			const blob = join(dir, "e2e-runtime.bin");
			expect(calls[calls.length - 2]).toEqual(runtimeBlobArgs("/repo", blob, "1.2.3"));
			expect(calls[calls.length - 1]).toContain(blob);
			expect(existsSync(blob)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a failed pack is the error and nothing is compiled", async () => {
		const calls: Array<readonly string[]> = [];
		const built = await buildFromSource(
			async (cmd) => {
				calls.push(cmd);
				return { exitCode: cmd[1]?.endsWith("e2e-runtime.ts") ? 1 : 0, stdout: "", stderr: "boom" };
			},
			"/repo",
			"1.2.3",
			"/out/warden",
			() => 0
		);
		expect(built.success).toBe(false);
		expect(calls.some((c) => c.includes("--compile"))).toBe(false);
	});
});
