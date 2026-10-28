import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import { callDevControl, type DevFeature, type DevFeatures, parseDevFeatures } from "../dev-control";
import { type DevSessionDeps, findDevSession } from "../dev-session";
import { reportError } from "../output";

export type DevControlOpts = { udid?: string; json?: boolean };
export type DevControlVerb = "enable" | "disable" | "status";

const defaultDeps: DevSessionDeps = {
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error instanceof Error && "code" in error && error.code === "EPERM";
		}
	},
};

const describeFeatures = (features: DevFeatures): string =>
	(Object.keys(features) as DevFeature[]).map((f) => `${f} ${features[f] ? "on" : "off"}`).join(" · ");

/**
 * `warden dev enable|disable <feature...>` / `warden dev status`: flips the perf HUD sampler and the CDP devtools
 * broker on a running `warden dev` (both start off), over the session's control socket. Each feature is one request;
 * a refused one is reported and the rest still apply (exit 1).
 */
export async function devControl(
	ctx: CommandContext,
	verb: DevControlVerb,
	names: string[],
	opts: DevControlOpts,
	deps: DevSessionDeps = defaultDeps
): Promise<number> {
	const scope = `dev ${verb}`;
	const parsed = verb === "status" ? undefined : parseDevFeatures(names);
	if (parsed !== undefined && !parsed.success) {
		reportError(ctx, scope, parsed.error);
		return 1;
	}
	const session = findDevSession(ctx.env, opts.udid === undefined ? {} : { udid: opts.udid }, deps);
	if (!session.success) {
		const { message, hint } = session.error;
		reportError(ctx, scope, hint === undefined ? message : `${message} (${hint})`);
		return 1;
	}
	const socket = session.data.controlSocket;
	if (socket === undefined) {
		reportError(ctx, scope, `no control socket for the session on ${session.data.deviceId} (restart \`warden dev\`)`);
		return 1;
	}
	const sent = await send(ctx, scope, socket, verb, parsed === undefined ? undefined : parsed.data);
	if (sent.features !== undefined) {
		ctx.out(
			opts.json === true
				? JSON.stringify({ udid: session.data.deviceId, features: sent.features })
				: `${session.data.deviceId}: ${describeFeatures(sent.features)}`
		);
	}
	return sent.failed ? 1 : 0;
}

/** One request per feature (one `status` when none); stops at a socket error, reports a refused feature and goes on. */
async function send(
	ctx: CommandContext,
	scope: string,
	socket: string,
	verb: DevControlVerb,
	features: readonly DevFeature[] | undefined
): Promise<{ features: DevFeatures | undefined; failed: boolean }> {
	let state: DevFeatures | undefined;
	let failed = false;
	for (const feature of features ?? [undefined]) {
		const called = await callDevControl(
			socket,
			feature === undefined ? { op: "status" } : { op: "set", feature, on: verb === "enable" }
		);
		if (!called.success) {
			reportError(ctx, scope, called.error);
			return { features: state, failed: true };
		}
		state = called.data.features;
		if (!called.data.ok) {
			failed = true;
			reportError(ctx, scope, `${feature}: ${called.data.error}`);
		}
	}
	return { features: state, failed };
}

/** Wires `enable` / `disable` / `status` onto `warden dev`; `deps` is the test seam. */
export function registerDevControl(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: DevSessionDeps = defaultDeps
): void {
	const features = "hud | perf | devtools | all (comma or space separated)";
	for (const verb of ["enable", "disable"] as const) {
		cmd
			.command(verb)
			.description(
				`${verb === "enable" ? "start" : "stop"} the perf HUD sampler and/or CDP devtools broker of a running \`warden dev\` (both start off)`
			)
			.argument("<features...>", features)
			.option("--udid <udid>", "the session on this device (default: the only running one)")
			.option("--json", "print { udid, features } as JSON")
			.action(async (names, opts) => done(await devControl(ctx, verb, names, opts, deps)));
	}
	cmd
		.command("status")
		.description("which extras (perf HUD, devtools broker) a running `warden dev` has on")
		.option("--udid <udid>", "the session on this device (default: the only running one)")
		.option("--json", "print { udid, features } as JSON")
		.action(async (opts) => done(await devControl(ctx, "status", [], opts, deps)));
}
