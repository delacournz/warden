import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, type ErrorResult, err, ok, type Result } from "@delacour/warden-types/result";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { NPM_PACKAGE, platformPackageName, releaseTarget } from "../npm/platforms";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import { type BuildInfo, currentBuild, describeBuild } from "../update/build-info";
import { installBinary } from "../update/install-binary";
import { installOrigin, recordInstallOrigin } from "../update/install-origin";
import { downloadNpmBinary, type Fetch, latestNpmVersion, npmRegistry, platformDist } from "../update/npm-registry";
import {
	describePackageInstall,
	detectPackageInstall,
	type PackageInstall,
	upgradeCommand,
} from "../update/package-install";
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
	/** npm registry client (`fetch`) */
	fetch: Fetch;
	/** version in `<sourceDir>/apps/cli/package.json` */
	readSourceVersion?: (sourceDir: string) => string;
};

type Flags = { check?: true; release?: true; force?: true; to?: string; json?: true };

type UpdateReport =
	| { status: "up-to-date"; current: string; latest: string; channel: BuildInfo["channel"] }
	| { status: "available"; current: string; latest: string; channel: BuildInfo["channel"] }
	| { status: "updated"; current: string; latest: string; channel: BuildInfo["channel"]; path: string; build: string }
	| { status: "managed"; current: string; channel: BuildInfo["channel"]; install: PackageInstall; command: string };

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

/** `up-to-date` / `available` when there's nothing to install (or `--check`); `undefined` = go ahead. */
function skipInstall(deps: UpdateDeps, flags: Flags, latest: string): UpdateReport | undefined {
	const base = { current: deps.build.version, latest, channel: deps.build.channel };
	const newer = compareVersions(latest, deps.build.version) > 0;
	const switching = deps.build.channel !== "release";
	if (!newer && !switching && !flags.force) return { status: "up-to-date", ...base };
	if (flags.check) return { status: newer ? "available" : "up-to-date", ...base };
	return undefined;
}

/**
 * Standalone binaries: from npm when this copy came from an npx / bunx install, else the latest
 * GitHub release, falling back to npm when GitHub releases can't be reached (no gh, no repo access).
 */
async function updateStandalone(
	ctx: CommandContext,
	deps: UpdateDeps,
	flags: Flags,
	target: string
): AsyncResult<UpdateReport> {
	if (installOrigin(ctx.env, deps.execPath) === "npm") return updateFromNpm(ctx, deps, flags, target);
	const github = await updateFromRelease(ctx, deps, flags, target);
	if (github.success || github.error.kind !== "unreachable") {
		return github.success ? github : err(github.error.message);
	}
	ctx.err(ctx.ui.color.dim(`GitHub releases unavailable — trying npm (${NPM_PACKAGE})`));
	const npm = await updateFromNpm(ctx, deps, flags, target);
	return npm.success ? npm : err(`${github.error.message}\nnpm: ${npm.error}`);
}

/** Latest `@delacour/warden` on npm → platform tarball → sha512 integrity check → atomic install at `target`. */
async function updateFromNpm(
	ctx: CommandContext,
	deps: UpdateDeps,
	flags: Flags,
	target: string
): AsyncResult<UpdateReport> {
	const platform = releaseTarget(deps.platform, deps.arch);
	if (!platform.success) return platform;
	const registry = npmRegistry(ctx.env);
	const latest = await step(
		ctx,
		`checking the latest ${NPM_PACKAGE} on npm…`,
		() => latestNpmVersion(deps.fetch, registry),
		(version) => `latest ${NPM_PACKAGE} ${version}`
	);
	if (!latest.success) return latest;
	const version = latest.data;
	const skipped = skipInstall(deps, flags, version);
	if (skipped) return ok(skipped);
	const name = `${platformPackageName(platform.data)}@${version}`;

	const dir = mkdtempSync(join(tmpdir(), "warden-update-"));
	try {
		const binary = join(dir, "warden");
		const downloaded = await step(
			ctx,
			`downloading ${name}…`,
			async (): AsyncResult<void> => {
				const dist = await platformDist(deps.fetch, registry, platform.data, version);
				if (!dist.success) return dist;
				const bytes = await downloadNpmBinary(deps.fetch, dist.data);
				if (!bytes.success) return bytes;
				writeFileSync(binary, bytes.data);
				return ok(undefined);
			},
			() => `downloaded ${name} (sha512 ok)`
		);
		if (!downloaded.success) return downloaded;
		const installed = await install(ctx, binary, target, version);
		if (!installed.success) return installed;
		recordInstallOrigin(ctx.env, target, "npm");
		return ok({
			status: "updated",
			current: deps.build.version,
			latest: version,
			channel: deps.build.channel,
			path: target,
			build: `${version} (npm ${NPM_PACKAGE}@${version})`,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Why a GitHub release update failed: `unreachable` (lookup failed) falls back to npm, `failed` doesn't. */
type ReleaseError = { kind: "unreachable" | "failed"; message: string };

function releaseError(kind: ReleaseError["kind"], message: string): ErrorResult<ReleaseError> {
	return { success: false, error: { kind, message } };
}

/** Latest GitHub release → download → sha256 check → atomic install at `target`. */
async function updateFromRelease(
	ctx: CommandContext,
	deps: UpdateDeps,
	flags: Flags,
	target: string
): Promise<Result<UpdateReport, ReleaseError>> {
	const failed = (message: string) => releaseError("failed", message);
	const repo = releaseRepo(ctx.env);
	const asset = assetName(deps.platform, deps.arch);
	if (!asset.success) return failed(asset.error);
	const latest = await step(
		ctx,
		`checking the latest release on ${repo}…`,
		(sctx) => latestRelease(sctx.exec, repo),
		(release) => `latest release ${release.tag}`
	);
	if (!latest.success) return releaseError("unreachable", latest.error);
	const base = { current: deps.build.version, latest: latest.data.version, channel: deps.build.channel };
	const skipped = skipInstall(deps, flags, latest.data.version);
	if (skipped) return ok(skipped);
	const picked = pickAsset(latest.data, asset.data);
	if (!picked.success) return failed(picked.error);
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
		if (!downloaded.success) return failed(downloaded.error);
		const installed = await install(ctx, binary, target, latest.data.version);
		if (!installed.success) return failed(installed.error);
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
	const managed = flags.to === undefined ? detectPackageInstall(deps.execPath) : undefined;
	if (managed) {
		return Promise.resolve(
			ok({
				status: "managed",
				current: build.version,
				channel: build.channel,
				install: managed,
				command: upgradeCommand(managed),
			})
		);
	}
	if (flags.release || build.channel === "release") return updateStandalone(ctx, deps, flags, target);
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
		case "managed":
			return `${color.yellow(`warden ${report.current} (${describePackageInstall(report.install)}) — upgrade it with:`)}\n  ${report.command}`;
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
 * - release binary (or `--release`) → download the latest GitHub release (sha256-verified), in place;
 *   a copy installed via npx / bunx, or no reachable GitHub releases → the latest npm package (sha512-verified)
 * - npm package install (`node_modules/@delacour/warden-<target>/`) → print the package manager's upgrade command
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
	fetch: (url) => fetch(url),
});
