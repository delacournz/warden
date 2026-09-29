import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@warden/types/result";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import { type BuildInfo, currentBuild, describeBuild } from "../update/build-info";
import { installBinary } from "../update/install-binary";
import { assetName, downloadRelease, latestRelease, parseChecksums, pickAsset, releaseRepo } from "../update/release";
import { buildFromSource, cliDir } from "../update/source-build";
import { compareVersions } from "../update/version";

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

type Flags = { check?: true; release?: true; force?: true; to?: string; json?: true };

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

/** One step under a spinner: ✓ `succeeded(data)` on success, ✗ on failure (the error is reported by the caller). */
function step<T>(
	ctx: CommandContext,
	text: string,
	work: (ctx: CommandContext) => AsyncResult<T>,
	succeeded: (data: T) => string
): AsyncResult<T> {
	return withSpinner(ctx, text, async (sctx, spinner) => {
		const result = await work(sctx);
		if (result.success) spinner.succeed(succeeded(result.data));
		else spinner.fail();
		return result;
	});
}

/** Stage `binary` at `target` and run its self-check (`version --json`) before swapping it in. */
function install(ctx: CommandContext, binary: string, target: string, version: string): AsyncResult<void> {
	return step(
		ctx,
		`installing ${target}…`,
		(sctx) => installBinary(sctx.exec, binary, target, version),
		() => `installed ${version} (self-check ok)`
	);
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
	const latest = await step(
		ctx,
		`checking the latest release on ${repo}…`,
		(sctx) => latestRelease(sctx.exec, repo),
		(release) => `latest release ${release.tag}`
	);
	if (!latest.success) return latest;
	const base = { current: deps.build.version, latest: latest.data.version, channel: deps.build.channel };
	const newer = compareVersions(latest.data.version, deps.build.version) > 0;
	const switching = deps.build.channel !== "release";
	if (!newer && !switching && !flags.force) return ok({ status: "up-to-date", ...base });
	if (flags.check) return ok({ status: newer ? "available" : "up-to-date", ...base });
	const picked = pickAsset(latest.data, asset.data);
	if (!picked.success) return picked;
	const name = picked.data;

	const dir = mkdtempSync(join(tmpdir(), "warden-update-"));
	try {
		const binary = join(dir, name);
		const downloaded = await step(
			ctx,
			`downloading ${name} ${latest.data.tag}…`,
			async (sctx): AsyncResult<void> => {
				const fetched = await downloadRelease(sctx.exec, repo, latest.data, name, dir);
				if (!fetched.success) return fetched;
				const expected = parseChecksums(readFileSync(join(dir, "checksums.txt"), "utf8")).get(name);
				const actual = sha256File(binary);
				return expected === actual
					? ok(undefined)
					: err(`checksum mismatch for ${name} (expected ${expected ?? "none"}, got ${actual})`);
			},
			() => `downloaded ${name} ${latest.data.tag} (sha256 ok)`
		);
		if (!downloaded.success) return downloaded;
		const installed = await install(ctx, binary, target, latest.data.version);
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
		const built = await step(
			ctx,
			`building ${sourceDir}…`,
			(sctx) => buildFromSource(sctx.exec, sourceDir, version, outfile, sctx.now),
			(build) => `built ${describeBuild(build)}`
		);
		if (!built.success) return built;
		const installed = await install(ctx, outfile, target, version);
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

function reportText(ctx: CommandContext, report: UpdateReport): string {
	const { color } = ctx.ui;
	switch (report.status) {
		case "up-to-date":
			return `${color.green(`warden ${report.current} is up to date`)} ${color.dim(`(latest ${report.latest})`)}`;
		case "available":
			return `${color.yellow(`update available: ${report.current} → ${report.latest}`)} ${color.dim("(run `warden update`)")}`;
		case "updated": {
			const headline =
				report.current === report.latest ? "warden rebuilt" : `warden updated ${report.current} → ${report.latest}`;
			return `${color.green(`${headline}: ${report.build}`)}\n${color.dim(`installed at ${report.path} — active now`)}`;
		}
	}
}

async function update(ctx: CommandContext, deps: UpdateDeps, flags: Flags): Promise<number> {
	const { color } = ctx.ui;
	const target = flags.to ?? defaultTarget(ctx, deps);
	const report = await plan(ctx, deps, flags, target);
	if (!report.success) {
		ctx.err(color.red(`warden update: ${report.error}`));
		return 1;
	}
	emit(ctx, flags.json === true, report.data, reportText(ctx, report.data));
	if (report.data.status === "updated") {
		const resolved = deps.which("warden", ctx.env.PATH);
		if (resolved !== report.data.path) {
			ctx.err(
				color.yellow(
					`note: your PATH resolves \`warden\` to ${resolved ?? "nothing"}, not ${report.data.path} — add its directory to PATH (then \`hash -r\`)`
				)
			);
		}
	}
	return 0;
}

/**
 * `warden update`:
 * - from source (dev) → compile a `local` binary from this checkout into `~/.local/bin/warden`
 * - locally built binary → rebuild from its recorded checkout, in place
 * - release binary (or `--release`) → download the latest GitHub release (sha256-verified), in place
 * The binary is swapped atomically at the same path, so the current shell's next `warden` runs it.
 */
export function createUpdateCommand(deps: UpdateDeps): Command {
	return defineCommand({
		name: "update",
		summary: "update warden: rebuild from source (dev/local builds) or install the latest release",
		register: (cmd, ctx, done) => {
			cmd
				.option("--check", "only report whether an update is available")
				.option("--release", "install the latest GitHub release (also switches a dev/local build to it)")
				.option("--force", "reinstall even when up to date")
				.option("--to <path>", "install the binary here instead")
				.option("--json", "machine-readable output")
				.action(async (opts) => done(await update(ctx, deps, opts)));
		},
	});
}

export const updateCommand: Command = createUpdateCommand({
	build: currentBuild(),
	platform: process.platform,
	arch: process.arch,
	execPath: process.execPath,
	which: (cmd, path) => Bun.which(cmd, path === undefined ? {} : { PATH: path }),
});
