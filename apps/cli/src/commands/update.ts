import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, type ErrorResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { NPM_PACKAGE, npmPlatforms } from "../npm/platforms";
import { output } from "../output";
import { spinnerContext } from "../spinner-context";
import { type BuildInfo, buildInfoHelpers } from "../update/build-info";
import { installBinaryHelpers } from "../update/install-binary";
import { installOriginHelpers } from "../update/install-origin";
import { type Fetch, npmRegistryHelpers } from "../update/npm-registry";
import { type PackageInstall, packageInstallHelpers } from "../update/package-install";
import { updateRelease } from "../update/release";
import { sourceBuild } from "../update/source-build";
import { updateVersion } from "../update/version";

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

/** Why a GitHub release update failed: `unreachable` (lookup failed) falls back to npm, `failed` doesn't. */
type ReleaseError = { kind: "unreachable" | "failed"; message: string };

export class UpdateCommand extends CliCommand {
	override readonly name = "update";
	override readonly group = "Setup";
	override readonly summary = "update warden: rebuild from source (dev/local builds) or install the latest release";

	constructor(private readonly deps: UpdateDeps) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.option("--check", "only report whether an update is available")
			.option("--release", "install the latest GitHub release (also switches a dev/local build to it)")
			.option("--force", "reinstall even when up to date")
			.option("--to <path>", "install the binary here instead")
			.option("--json", "machine-readable output")
			.action(async (opts) => done(await this.update(ctx, this.deps, opts)));
	}

	private readonly sourceVersion = (sourceDir: string): string => {
		const pkg: unknown = JSON.parse(readFileSync(join(sourceBuild.cliDir(sourceDir), "package.json"), "utf8"));
		return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string"
			? pkg.version
			: "0.0.0";
	};

	private sha256File(path: string): string {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	}

	/** One step under a spinner: ✓ `succeeded(data)` on success, ✗ on failure (the error is reported by the caller). */
	private step<T>(
		ctx: CommandContext,
		text: string,
		work: (ctx: CommandContext) => AsyncResult<T>,
		succeeded: (data: T) => string
	): AsyncResult<T> {
		return spinnerContext.withSpinner(ctx, text, async (sctx, spinner) => {
			const result = await work(sctx);
			if (result.success) spinner.succeed(succeeded(result.data));
			else spinner.fail();
			return result;
		});
	}

	/** Stage `binary` at `target` and run its self-check (`version --json`) before swapping it in. */
	private install(ctx: CommandContext, binary: string, target: string, version: string): AsyncResult<void> {
		return this.step(
			ctx,
			`installing ${target}…`,
			(sctx) => installBinaryHelpers.installBinary(sctx.exec, binary, target, version),
			() => `installed ${version} (self-check ok)`
		);
	}

	private defaultTarget(ctx: CommandContext, deps: UpdateDeps): string {
		return deps.build.channel === "dev" ? join(ctx.env.HOME ?? "~", ".local", "bin", "warden") : deps.execPath;
	}

	/** `up-to-date` / `available` when there's nothing to install (or `--check`); `undefined` = go ahead. */
	private skipInstall(deps: UpdateDeps, flags: Flags, latest: string): UpdateReport | undefined {
		const base = { current: deps.build.version, latest, channel: deps.build.channel };
		const newer = updateVersion.compareVersions(latest, deps.build.version) > 0;
		const switching = deps.build.channel !== "release";
		if (!newer && !switching && !flags.force) return { status: "up-to-date", ...base };
		if (flags.check) return { status: newer ? "available" : "up-to-date", ...base };
		return undefined;
	}

	/**
	 * Standalone binaries: from npm when this copy came from an npx / bunx install, else the latest
	 * GitHub release, falling back to npm when GitHub releases can't be reached (no gh, no repo access).
	 */
	private async updateStandalone(
		ctx: CommandContext,
		deps: UpdateDeps,
		flags: Flags,
		target: string
	): AsyncResult<UpdateReport> {
		if (installOriginHelpers.installOrigin(ctx.env, deps.execPath) === "npm")
			return this.updateFromNpm(ctx, deps, flags, target);
		const github = await this.updateFromRelease(ctx, deps, flags, target);
		if (github.success || github.error.kind !== "unreachable") {
			return github.success ? github : resultFactory.err(github.error.message);
		}
		output.note(ctx, `GitHub releases unavailable — trying npm (${NPM_PACKAGE})`);
		const npm = await this.updateFromNpm(ctx, deps, flags, target);
		return npm.success ? npm : resultFactory.err(`${github.error.message}\nnpm: ${npm.error}`);
	}

	/** Latest `@delacour/warden` on npm → platform tarball → sha512 integrity check → atomic install at `target`. */
	private async updateFromNpm(
		ctx: CommandContext,
		deps: UpdateDeps,
		flags: Flags,
		target: string
	): AsyncResult<UpdateReport> {
		const platform = npmPlatforms.releaseTarget(deps.platform, deps.arch);
		if (!platform.success) return platform;
		const registry = npmRegistryHelpers.npmRegistry(ctx.env);
		const latest = await this.step(
			ctx,
			`checking the latest ${NPM_PACKAGE} on npm…`,
			() => npmRegistryHelpers.latestNpmVersion(deps.fetch, registry),
			(version) => `latest ${NPM_PACKAGE} ${version}`
		);
		if (!latest.success) return latest;
		const version = latest.data;
		const skipped = this.skipInstall(deps, flags, version);
		if (skipped) return resultFactory.ok(skipped);
		const name = `${npmPlatforms.platformPackageName(platform.data)}@${version}`;

		const dir = mkdtempSync(join(tmpdir(), "warden-update-"));
		try {
			const binary = join(dir, "warden");
			const downloaded = await this.step(
				ctx,
				`downloading ${name}…`,
				async (): AsyncResult<void> => {
					const dist = await npmRegistryHelpers.platformDist(deps.fetch, registry, platform.data, version);
					if (!dist.success) return dist;
					const bytes = await npmRegistryHelpers.downloadNpmBinary(deps.fetch, dist.data);
					if (!bytes.success) return bytes;
					writeFileSync(binary, bytes.data);
					return resultFactory.ok(undefined);
				},
				() => `downloaded ${name} (sha512 ok)`
			);
			if (!downloaded.success) return downloaded;
			const installed = await this.install(ctx, binary, target, version);
			if (!installed.success) return installed;
			installOriginHelpers.recordInstallOrigin(ctx.env, target, "npm");
			return resultFactory.ok({
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

	private releaseError(kind: ReleaseError["kind"], message: string): ErrorResult<ReleaseError> {
		return { success: false, error: { kind, message } };
	}

	/** Latest GitHub release → download → sha256 check → atomic install at `target`. */
	private async updateFromRelease(
		ctx: CommandContext,
		deps: UpdateDeps,
		flags: Flags,
		target: string
	): Promise<Result<UpdateReport, ReleaseError>> {
		const failed = (message: string) => this.releaseError("failed", message);
		const repo = updateRelease.releaseRepo(ctx.env);
		const asset = updateRelease.assetName(deps.platform, deps.arch);
		if (!asset.success) return failed(asset.error);
		const latest = await this.step(
			ctx,
			`checking the latest release on ${repo}…`,
			(sctx) => updateRelease.latestRelease(sctx.exec, repo),
			(release) => `latest release ${release.tag}`
		);
		if (!latest.success) return this.releaseError("unreachable", latest.error);
		const base = { current: deps.build.version, latest: latest.data.version, channel: deps.build.channel };
		const skipped = this.skipInstall(deps, flags, latest.data.version);
		if (skipped) return resultFactory.ok(skipped);
		const picked = updateRelease.pickAsset(latest.data, asset.data);
		if (!picked.success) return failed(picked.error);
		const name = picked.data;

		const dir = mkdtempSync(join(tmpdir(), "warden-update-"));
		try {
			const binary = join(dir, name);
			const downloaded = await this.step(
				ctx,
				`downloading ${name} ${latest.data.tag}…`,
				async (sctx): AsyncResult<void> => {
					const fetched = await updateRelease.downloadRelease(sctx.exec, repo, latest.data, name, dir);
					if (!fetched.success) return fetched;
					const expected = updateRelease.parseChecksums(readFileSync(join(dir, "checksums.txt"), "utf8")).get(name);
					const actual = this.sha256File(binary);
					return expected === actual
						? resultFactory.ok(undefined)
						: resultFactory.err(`checksum mismatch for ${name} (expected ${expected ?? "none"}, got ${actual})`);
				},
				() => `downloaded ${name} ${latest.data.tag} (sha256 ok)`
			);
			if (!downloaded.success) return failed(downloaded.error);
			const installed = await this.install(ctx, binary, target, latest.data.version);
			if (!installed.success) return failed(installed.error);
			return resultFactory.ok({
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
	private async updateFromSource(
		ctx: CommandContext,
		deps: UpdateDeps,
		flags: Flags,
		sourceDir: string,
		target: string
	): AsyncResult<UpdateReport> {
		const version = (deps.readSourceVersion ?? this.sourceVersion)(sourceDir);
		const base = { current: deps.build.version, latest: version, channel: deps.build.channel };
		if (flags.check) return resultFactory.ok({ status: "available", ...base });
		const dir = mkdtempSync(join(tmpdir(), "warden-build-"));
		try {
			const outfile = join(dir, "warden");
			const built = await this.step(
				ctx,
				`building ${sourceDir}…`,
				(sctx) => sourceBuild.buildFromSource(sctx.exec, sourceDir, version, outfile, sctx.now),
				(build) => `built ${buildInfoHelpers.describeBuild(build)}`
			);
			if (!built.success) return built;
			const installed = await this.install(ctx, outfile, target, version);
			if (!installed.success) return installed;
			return resultFactory.ok({
				status: "updated",
				...base,
				path: target,
				build: buildInfoHelpers.describeBuild(built.data),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	private plan(ctx: CommandContext, deps: UpdateDeps, flags: Flags, target: string): AsyncResult<UpdateReport> {
		const build = deps.build;
		const managed = flags.to === undefined ? packageInstallHelpers.detectPackageInstall(deps.execPath) : undefined;
		if (managed) {
			return Promise.resolve(
				resultFactory.ok({
					status: "managed",
					current: build.version,
					channel: build.channel,
					install: managed,
					command: packageInstallHelpers.upgradeCommand(managed),
				})
			);
		}
		if (flags.release || build.channel === "release") return this.updateStandalone(ctx, deps, flags, target);
		if (!build.sourceDir) {
			return Promise.resolve(
				resultFactory.err(
					"this warden was built locally but doesn't know its source dir — rebuild it, or run `warden update --release`"
				)
			);
		}
		return this.updateFromSource(ctx, deps, flags, build.sourceDir, target);
	}

	private reportText(ctx: CommandContext, report: UpdateReport): string {
		const { color } = ctx.ui;
		switch (report.status) {
			case "up-to-date":
				return `${color.green(`warden ${report.current} is up to date`)} ${color.dim(`(latest ${report.latest})`)}`;
			case "available":
				return `${color.yellow(`update available: ${report.current} → ${report.latest}`)} ${color.dim("(run `warden update`)")}`;
			case "managed":
				return `${color.yellow(`warden ${report.current} (${packageInstallHelpers.describePackageInstall(report.install)}) — upgrade it with:`)}\n  ${report.command}`;
			case "updated": {
				const headline =
					report.current === report.latest ? "warden rebuilt" : `warden updated ${report.current} → ${report.latest}`;
				return `${color.green(`${headline}: ${report.build}`)}\n${color.dim(`installed at ${report.path} — active now`)}`;
			}
		}
	}

	private async update(ctx: CommandContext, deps: UpdateDeps, flags: Flags): Promise<number> {
		const target = flags.to ?? this.defaultTarget(ctx, deps);
		if (!flags.json) output.heading(ctx, "update", buildInfoHelpers.describeBuild(deps.build));
		const report = await this.plan(ctx, deps, flags, target);
		if (!report.success) {
			output.reportError(ctx, "update", report.error);
			return 1;
		}
		output.emit(ctx, flags.json === true, report.data, this.reportText(ctx, report.data));
		if (report.data.status === "updated") {
			const resolved = deps.which("warden", ctx.env.PATH);
			if (resolved !== report.data.path) {
				output.warn(
					ctx,
					`note: your PATH resolves \`warden\` to ${resolved ?? "nothing"}, not ${report.data.path} — add its directory to PATH (then \`hash -r\`)`
				);
			}
		}
		return 0;
	}
}

export const updateCommand = new UpdateCommand({
	build: buildInfoHelpers.currentBuild(),
	platform: process.platform,
	arch: process.arch,
	execPath: process.execPath,
	which: (cmd, path) => Bun.which(cmd, path === undefined ? {} : { PATH: path }),
	fetch: (url) => fetch(url),
}).definition();
