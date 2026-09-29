import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec, ExecResult } from "@warden/core/exec";
import { scriptedUi, type TestContext, testContext } from "../testing";
import type { BuildInfo } from "../update/build-info";
import { createUpdateCommand, type UpdateDeps } from "./update";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type FakeOpts = {
	latest?: string;
	binary?: string;
	checksum?: string;
	/** version the freshly installed binary reports */
	reports?: string;
	gitDirty?: boolean;
};

type Handler = { match: (bin: string, args: string[]) => boolean; run: (args: string[]) => string };

function fakeHandlers(opts: FakeOpts): Handler[] {
	const latest = opts.latest ?? "v0.3.0";
	const binary = opts.binary ?? "NEW-BINARY";
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	return [
		{
			match: (bin, args) => bin === "gh" && args[1] === "view",
			run: () =>
				JSON.stringify({ tagName: latest, assets: [{ name: "warden-darwin-arm64" }, { name: "checksums.txt" }] }),
		},
		{
			match: (bin, args) => bin === "gh" && args[1] === "download",
			run: (args) => {
				const dir = flag(args, "--dir");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "warden-darwin-arm64"), binary);
				writeFileSync(join(dir, "checksums.txt"), `${opts.checksum ?? sha(binary)}  warden-darwin-arm64\n`);
				return "";
			},
		},
		{
			match: (bin, args) => bin === "bun" && args[0] === "build",
			run: (args) => {
				writeFileSync(flag(args, "--outfile"), "LOCAL-BUILD");
				return "";
			},
		},
		{ match: (bin, args) => bin === "git" && args.includes("rev-parse"), run: () => "abc1234\n" },
		{ match: (bin, args) => bin === "git" && args.includes("status"), run: () => (opts.gitDirty ? " M x.ts\n" : "") },
		{ match: (bin) => bin === "xattr", run: () => "" },
		{
			match: (_, args) => args[0] === "version",
			run: () => JSON.stringify({ version: opts.reports ?? latest.replace(/^v/, "") }),
		},
	];
}

/** Fake exec: gh release view/download, bun build (must run in the cli dir), git, xattr, `<bin> version --json`. */
function fakeExec(opts: FakeOpts, calls: string[][]): Exec {
	const handlers = fakeHandlers(opts);
	return async (cmd, execOpts): Promise<ExecResult> => {
		calls.push([...cmd]);
		const [bin = "", ...args] = cmd;
		if (bin === "bun") expect(execOpts?.cwd).toBeDefined();
		const handler = handlers.find((h) => h.match(bin, args));
		return handler
			? { exitCode: 0, stdout: handler.run(args), stderr: "" }
			: { exitCode: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
	};
}

function setup(argv: string[], build: BuildInfo, fake: FakeOpts = {}) {
	const calls: string[][] = [];
	ctx = testContext(argv);
	ctx.exec = fakeExec(fake, calls);
	const binDir = join(ctx.cwd, "bin");
	mkdirSync(binDir, { recursive: true });
	const execPath = join(binDir, "warden");
	writeFileSync(execPath, "OLD-BINARY");
	ctx.env = { ...ctx.env, PATH: binDir };
	const deps: UpdateDeps = {
		build,
		platform: "darwin",
		arch: "arm64",
		execPath,
		which: () => execPath,
	};
	return { c: ctx, calls, deps, execPath };
}

const release = (version = "0.2.0"): BuildInfo => ({ channel: "release", version });

describe("warden update (release binary)", () => {
	test("up to date → nothing downloaded", async () => {
		const { c, calls, deps, execPath } = setup([], release("0.3.0"));
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain("up to date");
		expect(calls.some((cmd) => cmd.includes("download"))).toBe(false);
		expect(readFileSync(execPath, "utf8")).toBe("OLD-BINARY");
	});

	test("newer release → download, verify checksum, replace in place", async () => {
		const { c, calls, deps, execPath } = setup([], release());
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(readFileSync(execPath, "utf8")).toBe("NEW-BINARY");
		expect(calls.find((cmd) => cmd[0] === "gh" && cmd[2] === "download")).toContain("v0.3.0");
		expect(c.stdout.join("\n")).toContain("0.2.0 → 0.3.0");
	});

	test("--check only reports", async () => {
		const { c, calls, deps, execPath } = setup(["--check", "--json"], release());
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ status: "available", current: "0.2.0", latest: "0.3.0" });
		expect(calls.some((cmd) => cmd.includes("download"))).toBe(false);
		expect(readFileSync(execPath, "utf8")).toBe("OLD-BINARY");
	});

	test("checksum mismatch → exit 1, binary untouched", async () => {
		const { c, deps, execPath } = setup([], release(), { checksum: "deadbeef" });
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("checksum");
		expect(readFileSync(execPath, "utf8")).toBe("OLD-BINARY");
	});

	test("new binary reports the wrong version → exit 1, binary untouched", async () => {
		const { c, deps, execPath } = setup([], release(), { reports: "0.2.0" });
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(readFileSync(execPath, "utf8")).toBe("OLD-BINARY");
	});

	test("warns when the shell resolves warden somewhere else", async () => {
		const { c, deps } = setup([], release());
		deps.which = () => "/opt/homebrew/bin/warden";
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("/opt/homebrew/bin/warden");
	});
});

describe("warden update (from source)", () => {
	test("dev: builds a local binary from the checkout and installs to ~/.local/bin", async () => {
		const { c, calls, deps } = setup(
			[],
			{ channel: "dev", version: "0.2.0", sourceDir: "/repo" },
			{ reports: "0.2.0" }
		);
		mkdirSync(join(c.cwd, "src-pkg"), { recursive: true });
		deps.readSourceVersion = () => "0.2.0";
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		const target = join(c.env.HOME ?? "", ".local", "bin", "warden");
		expect(readFileSync(target, "utf8")).toBe("LOCAL-BUILD");
		expect(c.stdout.join("\n")).toContain("warden rebuilt: 0.2.0 (local abc1234");
		const build = calls.find((cmd) => cmd[0] === "bun" && cmd[1] === "build") ?? [];
		expect(build).toContain("/repo/apps/cli/src/cli.ts");
		const define = build[build.indexOf("--define") + 1] ?? "";
		expect(define.startsWith("__WARDEN_BUILD__=")).toBe(true);
		expect(JSON.parse(define.slice("__WARDEN_BUILD__=".length))).toMatchObject({
			channel: "local",
			version: "0.2.0",
			sourceDir: "/repo",
			commit: "abc1234",
		});
	});

	test("local binary: rebuilds from its recorded source dir, in place", async () => {
		const { c, deps, execPath } = setup(
			[],
			{ channel: "local", version: "0.2.0", sourceDir: "/repo" },
			{ gitDirty: true }
		);
		deps.readSourceVersion = () => "0.2.1";
		c.exec = fakeExec({ reports: "0.2.1", gitDirty: true }, []);
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(readFileSync(execPath, "utf8")).toBe("LOCAL-BUILD");
		expect(c.stdout.join("\n")).toContain("warden updated 0.2.0 → 0.2.1: 0.2.1 (local abc1234-dirty");
	});

	test("local binary without a source dir → exit 1 with a hint", async () => {
		const { c, deps } = setup([], { channel: "local", version: "0.2.0" });
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--release");
	});

	test("local binary --release → switches to the latest release", async () => {
		const { c, deps, execPath } = setup(["--release"], { channel: "local", version: "0.2.0", sourceDir: "/repo" });
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(readFileSync(execPath, "utf8")).toBe("NEW-BINARY");
	});

	test("--to installs somewhere else", async () => {
		const { c, deps } = setup([], release());
		const to = join(c.cwd, "elsewhere", "warden");
		c.argv = ["--to", to];
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(existsSync(to)).toBe(true);
	});
});

describe("warden update (ui)", () => {
	test("spinners cover the release lookup, download + checksum and install self-check", async () => {
		const { c, deps } = setup([], release());
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(ui.events.filter((e) => e.startsWith("spin:") || e.startsWith("ok:"))).toEqual([
			"spin: checking the latest release on delacournz/warden…",
			"ok: latest release v0.3.0",
			"spin: downloading warden-darwin-arm64 v0.3.0…",
			"ok: downloaded warden-darwin-arm64 v0.3.0 (sha256 ok)",
			`spin: installing ${deps.execPath}…`,
			"ok: installed 0.3.0 (self-check ok)",
		]);
	});

	test("source build runs under a spinner", async () => {
		const { c, deps } = setup([], { channel: "local", version: "0.2.0", sourceDir: "/repo" }, { reports: "0.2.1" });
		deps.readSourceVersion = () => "0.2.1";
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(ui.events).toContain("spin: building /repo…");
		expect(ui.events.some((e) => e.startsWith("ok: built 0.2.1 (local abc1234"))).toBe(true);
	});

	test("failed step → spinner fails, error on stderr", async () => {
		const { c, deps } = setup([], release(), { checksum: "deadbeef" });
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(ui.events).toContain("fail: downloading warden-darwin-arm64 v0.3.0…");
		expect(c.stderr.join("\n")).toContain("warden update: checksum mismatch");
	});

	test("--json: stdout is only the JSON report", async () => {
		const { c, deps } = setup(["--json"], release());
		expect(await createUpdateCommand(deps).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ status: "updated", latest: "0.3.0" });
	});

	test("unknown option → commander usage error, exit 1", async () => {
		const { c, calls, deps } = setup(["--bogus"], release());
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("unknown option '--bogus'");
		expect(calls).toEqual([]);
	});

	test("--to without a path → usage error", async () => {
		const { c, deps } = setup(["--to"], release());
		expect(await createUpdateCommand(deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("argument missing");
	});
});
