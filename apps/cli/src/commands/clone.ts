import { allocator } from "@delacour/warden-leasing/allocate";
import { goldenNames } from "@delacour/warden-providers/golden-name";
import { simctlParser } from "@delacour/warden-providers/ios";
import { type SimctlSim, simctlListParser } from "@delacour/warden-providers/simctl-list";
import { execErrors } from "@delacour/warden-runtime/exec";
import { leaseModel } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
import { withSpinner } from "../spinner-context";

const DEVICE_TYPE_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

function findSource(sims: SimctlSim[], ref: string): Result<SimctlSim> {
	const byUdid = sims.find((s) => s.udid === ref);
	if (byUdid) return resultFactory.ok(byUdid);
	const byName = sims.filter((s) => s.name === ref && s.isAvailable);
	if (byName.length > 1)
		return resultFactory.err(`"${ref}" is ambiguous (${byName.map((s) => s.udid).join(", ")}) — use the udid`);
	return byName[0]
		? resultFactory.ok(byName[0])
		: resultFactory.err(`no simulator "${ref}" (see \`warden devices ios\`)`);
}

function profileOf(sim: SimctlSim): string | undefined {
	const type = sim.deviceTypeIdentifier;
	return type?.startsWith(DEVICE_TYPE_PREFIX)
		? leaseModel.profileSlug(type.slice(DEVICE_TYPE_PREFIX.length))
		: undefined;
}

/** Lowest free `warden-<profile>-N`. */
function nextPoolName(sims: SimctlSim[], profile: string): string {
	const taken = new Set(sims.map((s) => s.name));
	let n = 1;
	while (taken.has(allocator.wardenDeviceName(profile, n))) n++;
	return allocator.wardenDeviceName(profile, n);
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
	if (listed.exitCode !== 0) return fail(ctx, execErrors.format(listCmd, listed));
	const sims = simctlListParser.parseAll(listed.stdout);
	if (!sims.success) return fail(ctx, sims.error.message);
	const source = findSource(sims.data, ref);
	if (!source.success) return fail(ctx, source.error);
	if (source.data.state !== "Shutdown") {
		return fail(
			ctx,
			`${source.data.name} is ${source.data.state.toLowerCase()} — shut it down first (simctl clone needs a shut-down source)`
		);
	}
	const profile = profileOf(source.data) ?? leaseModel.profileSlug(source.data.name);
	const name = opts.name ?? nextPoolName(sims.data, profile);
	const cloneCmd = ["xcrun", "simctl", "clone", source.data.udid, name];
	if (!opts.json) output.heading(ctx, "clone", `${source.data.name} → ${name}`);
	const cloned = await withSpinner(ctx, `cloning ${source.data.name} → ${name}…`, async (_, spinner) => {
		const result = await ctx.exec(cloneCmd);
		if (result.exitCode === 0) spinner.succeed(`cloned ${name}`);
		else spinner.fail("clone failed");
		return result;
	});
	if (cloned.exitCode !== 0) return fail(ctx, execErrors.format(cloneCmd, cloned));
	const udid = cloned.stdout.trim();
	const runtime = simctlParser.shortRuntime(source.data.runtimeId);
	ctx.store().recordDevice({ platform: "ios", id: udid, name, profile, runtime }, ctx.now());
	const result = {
		udid,
		name,
		source: source.data.udid,
		profile,
		runtime,
		fromGolden: goldenNames.isGolden(source.data.name),
	};
	output.emit(
		ctx,
		opts.json === true,
		result,
		`${color.green(`${color.bold(name)} ${udid}`)} ${color.dim(`(cloned from ${source.data.name})`)} — claim it with \`warden claim ios --profile ${profile}\``
	);
	return 0;
}

function fail(ctx: CommandContext, error: string): number {
	output.reportError(ctx, "clone", error);
	return 1;
}

export const cloneCommand = defineCommand({
	name: "clone",
	group: "Devices",
	summary: "duplicate a shut-down iOS simulator into warden's pool (fast: no first boot)",
	register: (cmd, ctx, done) => {
		cmd
			.argument("<source>", "udid or name of the shut-down simulator to duplicate")
			.option("--name <name>", "the clone's name (default: next free warden-<profile>-N)")
			.option("--json", "machine-readable output")
			.action(async (source, opts) => done(await clone(ctx, source, opts)));
	},
});
