import { defineCommand } from "../command";
import type { CommandContext } from "../context";

const SCOPE = "__relay-dial";
const FAILED = 255;

type DialFlags = { api?: string; hostId?: string; account?: string; organization?: string };

function fail(line: string): number {
	process.stderr.write(`relay: ${line}\n`);
	return FAILED;
}

/**
 * `__relay-dial --api <url> --host-id <id> [--account a] [--organization o] -- <cmd…>`: what `sshArgv` runs for a
 * relayed host, with ssh's stdio and exit codes. Takes the relay from argv (not the registry): `host add --cloud`
 * dials before it records the host.
 */
async function relayDial(ctx: CommandContext, flags: DialFlags, cmd: string[]): Promise<number> {
	if (flags.api === undefined || flags.hostId === undefined) return fail("connect: --api and --host-id are required");
	const [{ authContext }, { dialRelay, dialUrl }, { laptopMachineId }] = await Promise.all([
		import("../remote/session"),
		import("../hosts/relay-dial"),
		import("../hosts/setup"),
	]);
	const auth = authContext(ctx, {
		...(flags.account !== undefined ? { account: flags.account } : {}),
		...(flags.organization !== undefined ? { organizationId: flags.organization } : {}),
	});
	if (!auth.success) return fail(`Permission denied: ${auth.error}`);
	const a = auth.data;
	if (a.kind === "none") return fail("Permission denied: not logged in; run warden login (or set WARDEN_TOKEN)");
	const token = a.kind === "env" ? a.token : a.credentials.token;
	return dialRelay({
		url: dialUrl(flags.api, flags.hostId),
		token,
		...(a.organization !== undefined ? { organization: a.organization } : {}),
		machine: laptopMachineId(ctx),
		cmd,
		stdin: Bun.stdin.stream(),
		out: (chunk) => void process.stdout.write(chunk),
		err: (chunk) => void process.stderr.write(chunk),
	});
}

export const relayDialCommand = defineCommand({
	name: SCOPE,
	summary: "run one command on a relayed host through warden-api, like ssh would (internal)",
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd
			.option("--api <url>")
			.option("--host-id <id>")
			.option("--account <name>")
			.option("--organization <id>")
			.argument("[cmd...]")
			.action(async (words, opts) => done(await relayDial(ctx, opts, words)));
	},
});
