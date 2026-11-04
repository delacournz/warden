import { parseDuration } from "@delacour/warden-core/duration";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { emit, note, reportError, success } from "../output";
import { type AttachJump, type AttachOptions, startAttach } from "./attach";

export type AttachFlags = {
	grant?: string;
	as: string;
	listen: string;
	advertise?: string;
	port?: string;
	tailscale?: true;
	jump?: string;
	jumpPort?: string;
	jumpIdentity?: string;
	for?: string;
	json?: true;
};

function port(raw: string | undefined, flag: string): Result<number | undefined> {
	if (raw === undefined) return ok(undefined);
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 && n < 65_536 ? ok(n) : err(`${flag}: not a port: ${raw}`);
}

function jumpOf(flags: AttachFlags): Result<AttachJump | undefined> {
	if (flags.jump === undefined) {
		return flags.jumpPort !== undefined || flags.jumpIdentity !== undefined
			? err("--jump-port / --jump-identity need --jump <user@bastion>")
			: ok(undefined);
	}
	const remote = port(flags.jumpPort, "--jump-port");
	if (!remote.success) return remote;
	if (remote.data === undefined) return err("--jump needs --jump-port <the bastion's loopback port>");
	return ok({
		target: flags.jump,
		remotePort: remote.data,
		...(flags.jumpIdentity !== undefined ? { identity: flags.jumpIdentity } : {}),
	});
}

async function listenAddress(ctx: CommandContext, flags: AttachFlags): Promise<Result<string>> {
	if (!flags.tailscale) return ok(flags.listen);
	const ip = await ctx.exec(["tailscale", "ip", "-4"]);
	const first = ip.stdout.trim().split("\n")[0]?.trim();
	return ip.exitCode === 0 && first ? ok(first) : err(`--tailscale: tailscale ip -4 failed: ${ip.stderr.trim()}`);
}

/** The attach request from the flags, or the first thing wrong with them. */
export async function attachOptions(ctx: CommandContext, flags: AttachFlags): Promise<Result<AttachOptions>> {
	if (flags.grant === undefined) return err("--grant <the laptop's key: warden host key there> is required");
	if ([flags.tailscale, flags.jump, flags.advertise].filter((f) => f !== undefined).length > 1) {
		return err("--tailscale, --advertise and --jump: pick one");
	}
	const sshdPort = port(flags.port, "--port");
	if (!sshdPort.success) return sshdPort;
	const jump = jumpOf(flags);
	if (!jump.success) return jump;
	const listen = await listenAddress(ctx, flags);
	if (!listen.success) return listen;
	return ok({
		grant: flags.grant,
		name: flags.as,
		listen: listen.data,
		...(flags.advertise !== undefined ? { advertise: flags.advertise } : {}),
		...(sshdPort.data !== undefined ? { port: sshdPort.data } : {}),
		...(jump.data !== undefined ? { jump: jump.data } : {}),
	});
}

/** Until Ctrl-C / SIGTERM, `--for` running out, or sshd / the dial-out exiting. */
function hold(exited: Promise<number>, forMs: number | undefined): Promise<string> {
	return new Promise((resolve) => {
		const done = (why: string) => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			resolve(why);
		};
		const onSignal = () => done("stopped");
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		if (forMs !== undefined) setTimeout(() => done("time is up"), forMs).unref();
		void exited.then((code) => done(`sshd or the dial-out exited (${code})`));
	});
}

/** `warden host attach`: start, print the laptop's `host add` line, hold, stop. */
export async function attachHost(ctx: CommandContext, flags: AttachFlags): Promise<number> {
	const forMs = flags.for === undefined ? ok(undefined) : parseDuration(flags.for);
	if (!forMs.success) {
		reportError(ctx, "host attach", `--for: ${forMs.error}`);
		return 1;
	}
	const opts = await attachOptions(ctx, flags);
	if (!opts.success) {
		reportError(ctx, "host attach", opts.error);
		return 1;
	}
	const started = await startAttach(ctx, opts.data);
	if (!started.success) {
		reportError(ctx, "host attach", started.error);
		return 1;
	}
	const a = started.data;
	emit(
		ctx,
		flags.json === true,
		{ name: opts.data.name, port: a.port, hostKey: a.hostKey, add: a.add },
		`on the laptop:\n  ${a.add}`
	);
	if (!flags.json) success(ctx, `sshd on ${opts.data.listen}:${a.port}; one laptop key granted`);
	const why = await hold(a.exited, forMs.data);
	await a.stop();
	note(ctx, `host attach: ${why}`);
	return why.startsWith("sshd") ? 1 : 0;
}
