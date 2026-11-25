#!/usr/bin/env bun
/**
 * Puts this checkout's CLI on PATH as `warden`, running from source, and takes it off again.
 *   bun scripts/link.ts link     → ~/.local/bin/warden becomes a shim to this checkout's src/cli.ts
 *   bun scripts/link.ts unlink   → whatever was there before: a binary, another link, or nothing
 *
 * `link --viewer` first builds `apps/viewer` (macOS app bundle, debug unless `--release`), then
 * links with `WARDEN_VIEWER_PATH` defaulted in the shim to that build, so `warden view` and
 * `claim --remote --view` open it with no release download. `--login <api-url>` then runs
 * `warden login --account <name>` (default `local`) against that warden-api.
 *
 * `link` is `warden install --shim`'s binary step with a memory (see `./link/state.ts`): it leaves
 * the hooks, skill and agent config alone, and no build is needed, since the shim runs the source.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { VIEWER_BINARY } from "../src/npm/viewer";
import { linkPaths, restoreLink, type ShimEnv, type Snapshot, snapshotLink, writeShim } from "./link/state";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const viewerDir = join(repoRoot, "apps", "viewer");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const paths = linkPaths(process.env.HOME ?? homedir());

const DESCRIPTION: Record<Snapshot["kind"], string> = {
	absent: "nothing, so it is removed",
	symlink: "the link that was there",
	moved: "the binary that was there",
};

const USAGE = "Usage: bun scripts/link.ts link [--viewer [--release]] [--login <api-url> [--account <name>]] | unlink";

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		viewer: { type: "boolean", default: false },
		release: { type: "boolean", default: false },
		login: { type: "string" },
		account: { type: "string", default: "local" },
	},
});

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function run(cmd: string[], cwd: string): void {
	console.log(`$ ${cmd.join(" ")}`);
	const result = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
	if (result.exitCode !== 0) fail(`failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
}

/** Builds the viewer app for this Mac and returns its executable. */
function buildViewer(profile: "debug" | "release"): string {
	if (process.platform !== "darwin") fail("--viewer builds the macOS app; link without it on this platform.");
	if (!existsSync(join(repoRoot, "node_modules", "@delacournz", "apogee"))) {
		fail("@delacournz/apogee is not installed: set NPM_TOKEN (read:packages) and run `bun install` first.");
	}
	const flags = profile === "debug" ? ["--debug", "--bundles", "app"] : ["--bundles", "app"];
	run(["bun", "run", "tauri:build", "--", ...flags], viewerDir);
	const binary = join(viewerDir, "src-tauri", "target", profile, "bundle", "macos", VIEWER_BINARY["darwin-arm64"]);
	if (!existsSync(binary)) fail(`the build finished but ${binary} is missing.`);
	return binary;
}

const command = positionals[0];

if (command === "link") {
	const env: ShimEnv = {};
	if (values.viewer) env.WARDEN_VIEWER_PATH = buildViewer(values.release ? "release" : "debug");
	snapshotLink(paths);
	writeShim(paths, cliPath, env);
	console.log(`linked ${paths.bin} → ${cliPath}\n\`bun run cli:unlink\` restores what was there before.`);
	if (env.WARDEN_VIEWER_PATH) console.log(`viewer: ${env.WARDEN_VIEWER_PATH} (WARDEN_VIEWER_PATH in your env wins)`);
	if (values.login) run([paths.bin, "login", "--account", values.account, "--api-url", values.login], repoRoot);
} else if (command === "unlink") {
	const outcome = restoreLink(paths, cliPath);
	if (outcome.kind === "restored") console.log(`restored ${paths.bin} to ${DESCRIPTION[outcome.was]}.`);
	if (outcome.kind === "replaced") console.log(`${paths.bin} has been installed for real since the link; left alone.`);
	if (outcome.kind === "not-linked") console.log(`${paths.bin} is not linked to this checkout; nothing to restore.`);
} else {
	fail(USAGE);
}
