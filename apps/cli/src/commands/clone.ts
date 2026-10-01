import { profileSlug, wardenDeviceName } from "@delacour/warden-core/allocate";
import { execError } from "@delacour/warden-core/exec";
import { type GoldenSim, isGoldenName, parseAllSims } from "@delacour/warden-core/golden/golden";
import { shortRuntime } from "@delacour/warden-core/providers/ios";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";

const DEVICE_TYPE_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

function findSource(sims: GoldenSim[], ref: string): Result<GoldenSim> {
	const byUdid = sims.find((s) => s.udid === ref);
	if (byUdid) return ok(byUdid);
	const byName = sims.filter((s) => s.name === ref && s.isAvailable);
	if (byName.length > 1) return err(`"${ref}" is ambiguous (${byName.map((s) => s.udid).join(", ")}) — use the udid`);
	return byName[0] ? ok(byName[0]) : err(`no simulator "${ref}" (see \`warden devices ios\`)`);
}

function profileOf(sim: GoldenSim): string | undefined {
	const type = sim.deviceTypeIdentifier;
	return type?.startsWith(DEVICE_TYPE_PREFIX) ? profileSlug(type.slice(DEVICE_TYPE_PREFIX.length)) : undefined;
}

/** Lowest free `warden-<profile>-N`. */
function nextPoolName(sims: GoldenSim[], profile: string): string {
	const taken = new Set(sims.map((s) => s.name));
	let n = 1;
	while (taken.has(wardenDeviceName(profile, n))) n++;
	return wardenDeviceName(profile, n);
}

/**
 * Duplicate a shut-down simulator (APFS copy-on-write: seconds, ~30 MB) — its data, settings and
 * installed apps come along, and it skips the first-boot migration if the source finished it. The
 * clone joins warden's pool (recorded as warden-created), so `warden claim` can hand it out.
 * A booted source is refused: `simctl clone` needs it shut down, and warden never shuts down a
 * device it doesn't own.
 */
async function clone(ctx: CommandContext, ref: string, opts: { name?: string; json?: true }): Promise<number> {
	const { color } = ctx.ui;
	const listCmd = ["xcrun", "simctl", "list", "devices", "-j"];
	const listed = await ctx.exec(listCmd);
	if (listed.exitCode !== 0) return fail(ctx, execError(listCmd, listed));
	const sims = parseAllSims(listed.stdout);
	if (!sims.success) return fail(ctx, sims.error);
	const source = findSource(sims.data, ref);
	if (!source.success) return fail(ctx, source.error);
	if (source.data.state !== "Shutdown") {
		return fail(
			ctx,
			`${source.data.name} is ${source.data.state.toLowerCase()} — shut it down first (simctl clone needs a shut-down source)`
		);
	}
	const profile = profileOf(source.data) ?? profileSlug(source.data.name);
	const name = opts.name ?? nextPoolName(sims.data, profile);
	const cloneCmd = ["xcrun", "simctl", "clone", source.data.udid, name];
	const cloned = await withSpinner(ctx, `cloning ${source.data.name} → ${name}…`, async (_, spinner) => {
		const result = await ctx.exec(cloneCmd);
		if (result.exitCode === 0) spinner.succeed(`cloned ${name}`);
		else spinner.fail("clone failed");
		return result;
	});
	if (cloned.exitCode !== 0) return fail(ctx, execError(cloneCmd, cloned));
	const udid = cloned.stdout.trim();
	const runtime = shortRuntime(source.data.runtimeId);
	ctx.store().recordDevice({ platform: "ios", id: udid, name, profile, runtime }, ctx.now());
	const result = { udid, name, source: source.data.udid, profile, runtime, fromGolden: isGoldenName(source.data.name) };
	emit(
		ctx,
		opts.json === true,
		result,
		`${color.green(`${color.bold(name)} ${udid}`)} ${color.dim(`(cloned from ${source.data.name})`)} — claim it with \`warden claim ios --profile ${profile}\``
	);
	return 0;
}

function fail(ctx: CommandContext, error: string): number {
	ctx.err(ctx.ui.color.red(`warden clone: ${error}`));
	return 1;
}

export const cloneCommand = defineCommand({
	name: "clone",
	summary: "duplicate a shut-down iOS simulator into warden's pool (fast: no first boot)",
	register: (cmd, ctx, done) => {
		cmd
			.argument("<source>", "udid or name of the shut-down simulator to duplicate")
			.option("--name <name>", "the clone's name (default: next free warden-<profile>-N)")
			.option("--json", "machine-readable output")
			.action(async (source, opts) => done(await clone(ctx, source, opts)));
	},
});
