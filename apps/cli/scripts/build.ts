#!/usr/bin/env bun
/**
 * Compile warden with embedded build info.
 *   bun scripts/build.ts                     → dist/warden (channel local, knows this checkout → `warden update` rebuilds it)
 *   bun scripts/build.ts --channel release   → dist/warden-<os>-<arch> for every release target + dist/checksums.txt
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bunExec } from "@delacour/warden-core/exec";
import { RUNNER_BLOB } from "@delacour/warden-core/ios-runner/pack";
import cliPackage from "../package.json" with { type: "json" };
import { RUNTIME_BLOB } from "../src/e2e/e2e-runtime";
import { RELEASE_TARGETS } from "../src/npm/platforms";
import {
	buildFromSource,
	compileArgs,
	runnerBlobArgs,
	runtimeBlobArgs,
	STRAY_SOURCE_MAP,
	sourceCommit,
} from "../src/update/source-build";

const cliRoot = resolve(import.meta.dir, "..");
const sourceDir = resolve(cliRoot, "..", "..");
const dist = join(cliRoot, "dist");
const { values } = parseArgs({ options: { channel: { type: "string", default: "local" } }, strict: true });

async function run(cmd: string[]): Promise<void> {
	const result = await bunExec(cmd, { cwd: cliRoot });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${result.stderr}`);
}

/** The binary embeds its source map; the loose copy `bun build --compile` leaves in `dist/` would ride along in dist.tgz. */
const dropStraySourceMap = () => rmSync(join(dist, STRAY_SOURCE_MAP), { force: true });

mkdirSync(dist, { recursive: true });
if (values.channel === "local") {
	const built = await buildFromSource(bunExec, sourceDir, cliPackage.version, join(dist, "warden"), Date.now);
	if (!built.success) throw new Error(built.error);
	dropStraySourceMap();
	console.log(`built dist/warden ${built.data.version} (local ${built.data.commit ?? "?"})`);
} else if (values.channel === "release") {
	const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? (await sourceCommit(bunExec, sourceDir));
	const info = {
		channel: "release" as const,
		version: cliPackage.version,
		...(commit ? { commit } : {}),
		builtAt: new Date().toISOString(),
	};
	const sums: string[] = [];
	const blob = join(dist, RUNTIME_BLOB);
	const runnerBlob = join(dist, RUNNER_BLOB);
	await run(runtimeBlobArgs(sourceDir, blob, cliPackage.version));
	await run(runnerBlobArgs(sourceDir, runnerBlob));
	for (const target of RELEASE_TARGETS) {
		const name = `warden-${target}`;
		const outfile = join(dist, name);
		await run(
			compileArgs({
				entry: join(cliRoot, "src", "cli.ts"),
				outfile,
				info,
				target: `bun-${target}`,
				embed: [blob, runnerBlob],
			})
		);
		dropStraySourceMap();
		sums.push(`${createHash("sha256").update(readFileSync(outfile)).digest("hex")}  ${name}`);
		console.log(`built dist/${name}`);
	}
	rmSync(blob, { force: true });
	rmSync(runnerBlob, { force: true });
	writeFileSync(join(dist, "checksums.txt"), `${sums.join("\n")}\n`);
	console.log(`release ${info.version}: ${RELEASE_TARGETS.length} binaries + checksums.txt`);
} else {
	throw new Error(`--channel must be local or release, got ${values.channel}`);
}
