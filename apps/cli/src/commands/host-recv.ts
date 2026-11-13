import { wardenHome } from "@delacour/warden-core/store";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { checkUpload, isUploadHash, isUploadName, receiveUpload } from "../hosts/upload";
import { emit, reportError } from "../output";

const SCOPE = "__host-recv";

export type HostRecvDeps = { input?: () => ReadableStream<Uint8Array> };

type RecvOpts = { hash?: string; name?: string; check?: true; json?: true };

async function recv(ctx: CommandContext, deps: HostRecvDeps, opts: RecvOpts): Promise<number> {
	const { hash, name } = opts;
	if (hash === undefined || name === undefined || !isUploadHash(hash) || !isUploadName(name)) {
		reportError(ctx, SCOPE, "--hash <sha256 hex> and --name <one path segment> are required");
		return 1;
	}
	const home = wardenHome(ctx.env);
	const json = opts.json === true;
	if (opts.check) {
		const found = checkUpload(home, hash, name);
		emit(ctx, json, found, found.present ? found.path : `${name} not here`);
		return 0;
	}
	const got = await receiveUpload(home, { hash, name }, (deps.input ?? (() => Bun.stdin.stream()))());
	if (!got.success) {
		reportError(ctx, SCOPE, got.error);
		return 1;
	}
	emit(ctx, json, { path: got.data }, got.data);
	return 0;
}

/** `__host-recv`: on a host, take an app build from a laptop (a tar on stdin), content-addressed and hash-checked. */
export function createHostRecvCommand(deps: HostRecvDeps = {}) {
	return defineCommand({
		name: SCOPE,
		summary: "receive an app build from a laptop into the host's uploads, checked against its hash (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd
				.option("--hash <sha256>")
				.option("--name <name>")
				.option("--check")
				.option("--json")
				.action(async (opts) => done(await recv(ctx, deps, opts)));
		},
	});
}

export const hostRecvCommand = createHostRecvCommand();
