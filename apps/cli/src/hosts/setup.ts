import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimError } from "@delacour/warden-core/claim-errors";
import { type HostRecord, putHost } from "@delacour/warden-core/hosts/registry";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { releaseTarget } from "../npm/platforms";
import { currentBuild } from "../update/build-info";
import { CHECKSUMS_ASSET, downloadRelease, parseChecksums, releaseRepo } from "../update/release";
import { keyComment } from "./keys";
import { hostVersion, runOnHost, wardenJson } from "./remote";
import { classifySshFailure, hostControlDir, sshArgv } from "./ssh";

/** The laptop side of `warden host setup`: its key, the binary for the host, the upload and the grant. */

const MACHINE_META = "host.machine-id";

/** This laptop's id on every host (random, made once per `WARDEN_HOME`): the `host:<machineId>` owner there. */
export function laptopMachineId(ctx: CommandContext): string {
	const store = ctx.store();
	const known = store.getMeta(MACHINE_META);
	if (known !== undefined) return known;
	const id = randomBytes(8).toString("hex");
	store.setMeta(MACHINE_META, id);
	return id;
}

export function laptopKeyPath(home: string): string {
	return join(home, "hosts", "id_ed25519");
}

/** The laptop's own warden key (made on first use), commented `warden:<machineId>:<user>`. */
export async function ensureLaptopKey(ctx: CommandContext): Promise<Result<{ path: string; publicKey: string }>> {
	const path = laptopKeyPath(wardenHome(ctx.env));
	if (!existsSync(path)) {
		mkdirSync(join(wardenHome(ctx.env), "hosts"), { recursive: true, mode: 0o700 });
		const user = (ctx.env.USER ?? ctx.env.LOGNAME ?? "user").replace(/[^A-Za-z0-9._@+-]/g, "_") || "user";
		const comment = keyComment(laptopMachineId(ctx), user);
		const made = await ctx.exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path]);
		if (made.exitCode !== 0) return err(`ssh-keygen failed: ${made.stderr.trim()}`);
	}
	return ok({ path, publicKey: readFileSync(`${path}.pub`, "utf8").trim() });
}

/** Streams `file` into `cmd` on the host (stdin); resolves the exit code and output. */
export type UploadFile = (
	argv: readonly string[],
	file: string
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const spawnUpload: UploadFile = async (argv, file) => {
	const proc = Bun.spawn([...argv], { stdin: Bun.file(file), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
};

export type SetupOptions = {
	/** the key that opens a normal shell on the host (default: the host's `--identity`) */
	setupIdentity?: string;
	/** a warden binary to install instead of downloading this version's release (a dev / local build) */
	binary?: string;
	/** where the binary goes on the host (default `$HOME/.local/bin`) */
	installDir?: string;
	/** the authorized_keys file on the host (default `~/.ssh/authorized_keys`) */
	authorizedKeys?: string;
	golden?: boolean;
	/** skip `doctor --fetch-helper` (a host whose helper is managed another way, tests) */
	noHelper?: boolean;
	upload?: UploadFile;
	log?: (line: string) => void;
};

export type SetupOutcome = {
	host: string;
	version: string;
	wardenPath: string;
	fingerprint: string;
	machineId: string;
	helper: "fetched" | "skipped" | "failed";
	golden?: "ensured" | "failed";
};

/** `uname -sm` → release target (`Darwin arm64` → `darwin-arm64`). */
export function targetFromUname(uname: string): Result<string> {
	const [os, arch] = uname.trim().split(/\s+/);
	const platform = os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : (os ?? "");
	const normalized = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : (arch ?? "");
	return releaseTarget(platform, normalized);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** This version's release binary for `target`, downloaded with gh and checked against the release checksums. */
async function releaseBinary(ctx: CommandContext, target: string, dir: string): Promise<Result<string>> {
	const build = currentBuild();
	if (build.channel !== "release") {
		return err(
			claimError(
				{ code: "HOST_VERSION_SKEW" },
				`this warden is a ${build.channel} build (${build.version}), which has no release to install: pass --binary <path to a warden for ${target}>`
			)
		);
	}
	const asset = `warden-${target}`;
	const tag = `v${build.version}`;
	const got = await downloadRelease(
		ctx.exec,
		releaseRepo(ctx.env),
		{ tag, version: build.version, assets: [] },
		asset,
		dir
	);
	if (!got.success) return got;
	const sums = parseChecksums(readFileSync(join(dir, CHECKSUMS_ASSET), "utf8"));
	const path = join(dir, asset);
	if (sums.get(asset) !== sha256(path)) return err(`${asset}: checksum does not match ${CHECKSUMS_ASSET}`);
	return ok(path);
}

/** POSIX sh that installs stdin as `<dir>/warden` atomically and prints its absolute path. */
export function installScript(installDir: string | undefined): string {
	const dir = installDir === undefined ? '"$HOME/.local/bin"' : `'${installDir.replaceAll("'", "'\\''")}'`;
	return [
		"set -e",
		`d=${dir}`,
		'mkdir -p "$d"',
		'cat > "$d/.warden.new"',
		'chmod 755 "$d/.warden.new"',
		'mv -f "$d/.warden.new" "$d/warden"',
		'cd "$d" && printf "%s/warden\\n" "$(pwd -P)"',
	].join("\n");
}

/**
 * Set a host up for this laptop: install this warden version there (no sudo), fetch the iOS helper, optionally
 * build the golden image, then grant this laptop's own key with the forced command and switch the host to it.
 * Every step before the grant runs with the setup key (a normal shell); everything after it through the grant.
 */
export async function setupHost(
	ctx: CommandContext,
	host: HostRecord,
	opts: SetupOptions
): Promise<Result<SetupOutcome>> {
	const log = opts.log ?? (() => undefined);
	const identity = opts.setupIdentity ?? host.identity;
	const shell: HostRecord = { ...host, ...(identity !== undefined ? { identity } : {}) };
	const key = await ensureLaptopKey(ctx);
	if (!key.success) return key;

	const uname = await runOnHost(ctx, shell, ["uname", "-sm"], { trustNew: host.hostKey === undefined });
	if (!uname.success) return uname;
	if (uname.data.exitCode !== 0) return err(`${host.name}: uname failed: ${uname.data.stderr.trim()}`);
	const target = targetFromUname(uname.data.stdout);
	if (!target.success) return target;

	const scratch = mkdtempSync(join(tmpdir(), "warden-host-setup-"));
	try {
		let binary = opts.binary;
		if (binary === undefined) {
			log(`downloading warden ${currentBuild().version} for ${target.data}…`);
			const got = await releaseBinary(ctx, target.data, scratch);
			if (!got.success) return got;
			binary = got.data;
		}
		if (!existsSync(binary)) return err(`--binary ${binary}: no such file`);
		log(`installing warden on ${host.name}…`);
		const home = wardenHome(ctx.env);
		mkdirSync(hostControlDir(home), { recursive: true, mode: 0o700 });
		const argv = sshArgv(shell, ["sh", "-c", installScript(opts.installDir)], { home });
		const uploaded = await (opts.upload ?? spawnUpload)(argv, binary);
		const sshFailure = classifySshFailure(uploaded.exitCode, uploaded.stderr);
		if (sshFailure !== undefined)
			return err(claimError({ code: sshFailure }, `${host.name}: ${uploaded.stderr.trim()}`));
		const wardenPath = uploaded.stdout.trim().split("\n").at(-1) ?? "";
		if (uploaded.exitCode !== 0 || !wardenPath.startsWith("/")) {
			return err(`${host.name}: install failed (exit ${uploaded.exitCode}): ${uploaded.stderr.trim()}`);
		}
		const installed: HostRecord = { ...shell, wardenPath };

		const version = await hostVersion(ctx, installed);
		if (!version.success) return version;

		let helper: SetupOutcome["helper"] = "skipped";
		if (target.data.startsWith("darwin") && !opts.noHelper) {
			log("fetching the iOS driver helper…");
			const fetched = await runOnHost(ctx, installed, [wardenPath, "doctor", "--fetch-helper", "--json"], {
				timeoutMs: 300_000,
			});
			helper = fetched.success && fetched.data.exitCode === 0 ? "fetched" : "failed";
		}
		let golden: SetupOutcome["golden"];
		if (opts.golden) {
			log("building the iOS golden image (minutes)…");
			const ensured = await runOnHost(ctx, installed, [wardenPath, "golden", "ensure", "--json"], {
				timeoutMs: 1_800_000,
			});
			golden = ensured.success && ensured.data.exitCode === 0 ? "ensured" : "failed";
		}

		log("granting this laptop's key…");
		const grantArgs = [
			"host",
			"grant",
			"--key",
			key.data.publicKey,
			"--warden",
			wardenPath,
			...(opts.authorizedKeys !== undefined ? ["--authorized-keys", opts.authorizedKeys] : []),
			"--json",
		];
		const granted = await wardenJson(ctx, installed, grantArgs);
		if (!granted.success) return granted;
		const grant = granted.data.json;
		const fingerprint = typeof grant === "object" && grant !== null ? Reflect.get(grant, "fingerprint") : undefined;
		const machineId = typeof grant === "object" && grant !== null ? Reflect.get(grant, "machineId") : undefined;
		if (granted.data.exitCode !== 0 || typeof fingerprint !== "string" || typeof machineId !== "string") {
			return err(`${host.name}: host grant failed: ${granted.data.stderr.trim()}`);
		}

		const final: HostRecord = { ...host, identity: key.data.path, wardenPath, version: version.data };
		const through = await hostVersion(ctx, final);
		if (!through.success) return through;
		putHost(ctx.store(), final);
		return ok({
			host: host.name,
			version: version.data,
			wardenPath,
			fingerprint,
			machineId,
			helper,
			...(golden !== undefined ? { golden } : {}),
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
