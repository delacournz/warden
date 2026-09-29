import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type AsyncResult, err, ok } from "@warden/types/result";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";
import { type BuildInfo, currentBuild, describeBuild } from "../update/build-info";
import { installBinary } from "../update/install-binary";
import { assetName, downloadRelease, latestRelease, parseChecksums, pickAsset, releaseRepo } from "../update/release";
import { buildFromSource, cliDir } from "../update/source-build";
import { compareVersions } from "../update/version";

const USAGE = "warden update [--check] [--release] [--force] [--to <path>] [--json]";

/** Outside world for `warden update`, injectable for tests. */
export type UpdateDeps = {
	build: BuildInfo;
	platform: string;
	arch: string;
	/** the running binary (compiled builds update this in place) */
	execPath: string;
	/** what `warden` resolves to on `PATH` */
	which: (cmd: string, path: string | undefined) => string | null;
	/** version in `<sourceDir>/apps/cli/package.json` */
	readSourceVersion?: (sourceDir: string) => string;
};

type Flags = { check: boolean; release: boolean; force: boolean; to?: string; json: boolean };

type UpdateReport =
	| { status: "up-to-date"; current: string; latest: string; channel: BuildInfo["channel"] }
	| { status: "available"; current: string; latest: string; channel: BuildInfo["channel"] }
	| { status: "updated"; current: string; latest: string; channel: BuildInfo["channel"]; path: string; build: string };

function sourceVersion(sourceDir: string): string {
	const pkg: unknown = JSON.parse(readFileSync(join(cliDir(sourceDir), "package.json"), "utf8"));
	return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string"
		? pkg.version
		: "0.0.0";
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultTarget(ctx: CommandContext, deps: UpdateDeps): string {
	return deps.build.channel === "dev" ? join(ctx.env.HOME ?? "~", ".local", "bin", "warden") : deps.execPath;
}

/** Latest GitHub release → download → sha256 check → atomic install at `target`. */
async function updateFromRelease(
	ctx: CommandContext,
	deps: UpdateDeps,
	flags: Flags,
	target: string
): AsyncResult<UpdateReport> {
	const repo = releaseRepo(ctx.env);
	const asset = assetName(deps.platform, deps.arch);
	if (!asset.success) return asset;
	const latest = await latestRelease(ctx.exec, repo);
	if (!latest.success) return latest;
	const base = { current: deps.build.version, latest: latest.data.version, channel: deps.build.channel };
	const newer = compareVersions(latest.data.version, deps.build.version) > 0;
	const switching = deps.build.channel !== "release";
	if (!newer && !switching && !flags.force) return ok({ status: "up-to-date", ...base });
	if (flags.check) return ok({ status: newer ? "available" : "up-to-date", ...base });
	const picked = pickAsset(latest.data, asset.data);
	if (!picked.success) return picked;

	const dir = mkdtempSync(join(tmpdir(), "warden-update-"));
	try {
		const downloaded = await downloadRelease(ctx.exec, repo, latest.data, picked.data, dir);
		if (!downloaded.success) return downloaded;
		const binary = join(dir, picked.data);
		const expected = parseChecksums(readFileSync(join(dir, "checksums.txt"), "utf8")).get(picked.data);
		const actual = sha256File(binary);
		if (expected !== actual)
			return err(`checksum mismatch for ${picked.data} (expected ${expected ?? "none"}, got ${actual})`);
		const installed = await installBinary(ctx.exec, binary, target, latest.data.version);
		if (!installed.success) return installed;
		return ok({
			status: "updated",
			...base,
			path: target,
			build: `${latest.data.version} (release ${latest.data.tag})`,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Rebuild a `local` binary from the checkout and install it at `target`. */
async function updateFromSource(
	ctx: CommandContext,
	deps: UpdateDeps,
	flags: Flags,
	sourceDir: string,
	target: string
): AsyncResult<UpdateReport> {
	const version = (deps.readSourceVersion ?? sourceVersion)(sourceDir);
	const base = { current: deps.build.version, latest: version, channel: deps.build.channel };
	if (flags.check) return ok({ status: "available", ...base });
	const dir = mkdtempSync(join(tmpdir(), "warden-build-"));
	try {
		const outfile = join(dir, "warden");
		ctx.err(`warden update: building ${sourceDir} …`);
		const built = await buildFromSource(ctx.exec, sourceDir, version, outfile, ctx.now);
		if (!built.success) return built;
		const installed = await installBinary(ctx.exec, outfile, target, version);
		if (!installed.success) return installed;
		return ok({ status: "updated", ...base, path: target, build: describeBuild(built.data) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function plan(ctx: CommandContext, deps: UpdateDeps, flags: Flags, target: string): AsyncResult<UpdateReport> {
	const build = deps.build;
	if (flags.release || build.channel === "release") return updateFromRelease(ctx, deps, flags, target);
	if (!build.sourceDir) {
		return Promise.resolve(
			err(
				"this warden was built locally but doesn't know its source dir — rebuild it, or run `warden update --release`"
			)
		);
	}
	return updateFromSource(ctx, deps, flags, build.sourceDir, target);
}

function reportText(report: UpdateReport): string {
	switch (report.status) {
		case "up-to-date":
			return `warden ${report.current} is up to date (latest ${report.latest})`;
		case "available":
			return `update available: ${report.current} → ${report.latest} (run \`warden update\`)`;
		case "updated":
			return `${report.current === report.latest ? "warden rebuilt" : `warden updated ${report.current} → ${report.latest}`}: ${report.build}\ninstalled at ${report.path} — active now`;
	}
}

function parseFlags(argv: string[]): Flags {
	const { values } = parseArgs({
		args: argv,
		options: {
			check: { type: "boolean" },
			release: { type: "boolean" },
			force: { type: "boolean" },
			to: { type: "string" },
			json: { type: "boolean" },
		},
		allowPositionals: false,
		strict: true,
	});
	const flags: Flags = {
		check: values.check === true,
		release: values.release === true,
		force: values.force === true,
		json: values.json === true,
	};
	if (values.to !== undefined) flags.to = values.to;
	return flags;
}

/**
 * `warden update`:
 * - from source (dev) → compile a `local` binary from this checkout into `~/.local/bin/warden`
 * - locally built binary → rebuild from its recorded checkout, in place
 * - release binary (or `--release`) → download the latest GitHub release (sha256-verified), in place
 * The binary is swapped atomically at the same path, so the current shell's next `warden` runs it.
 */
export function createUpdateCommand(deps: UpdateDeps): Command {
	async function run(ctx: CommandContext): Promise<number> {
		let flags: Flags;
		try {
			flags = parseFlags(ctx.argv);
		} catch (error) {
			ctx.err(`warden update: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
			return 1;
		}
		const target = flags.to ?? defaultTarget(ctx, deps);
		const report = await plan(ctx, deps, flags, target);
		if (!report.success) {
			ctx.err(`warden update: ${report.error}`);
			return 1;
		}
		emit(ctx, flags.json, report.data, reportText(report.data));
		if (report.data.status === "updated") {
			const resolved = deps.which("warden", ctx.env.PATH);
			if (resolved !== report.data.path) {
				ctx.err(
					`note: your PATH resolves \`warden\` to ${resolved ?? "nothing"}, not ${report.data.path} — add its directory to PATH (then \`hash -r\`)`
				);
			}
		}
		return 0;
	}
	return {
		name: "update",
		summary: "update warden: rebuild from source (dev/local builds) or install the latest release",
		usage: USAGE,
		run,
	};
}

export const updateCommand: Command = createUpdateCommand({
	build: currentBuild(),
	platform: process.platform,
	arch: process.arch,
	execPath: process.execPath,
	which: (cmd, path) => Bun.which(cmd, path === undefined ? {} : { PATH: path }),
});
