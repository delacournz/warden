import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { selfCommand } from "../self-command";
import { grantKey } from "./grant";
import { shellQuote } from "./ssh";

/**
 * `warden host attach`, run on a machine with no inbound ssh of its own (a CI runner, a fresh hosted Mac): a
 * user-level sshd (no sudo, keys only, only this user) whose one key is the laptop's, through the same forced
 * `__host-serve` as `host grant`, reachable on the tailnet or through a bastion it dials out to (`ssh -N -R`).
 */

export const SSHD = "/usr/sbin/sshd";

export type AttachJump = { target: string; remotePort: number; identity?: string };

export type AttachOptions = {
	/** the laptop's key (`warden host key` there): a public key line or a .pub file */
	grant: string;
	/** the name the laptop should give this host */
	name: string;
	/** sshd's listen address (`127.0.0.1`; the tailnet IP with `--tailscale`) */
	listen: string;
	/** the address the laptop uses (default: `listen`): a tailnet IP in front of a userspace tailscaled, a NAT */
	advertise?: string;
	/** sshd's port (default: a free one) */
	port?: number;
	jump?: AttachJump;
	/** the warden argv the forced command runs (default: this one) */
	warden?: readonly string[];
};

export type Attached = {
	port: number;
	/** sshd's public host key, for the laptop to pin */
	hostKey: string;
	/** the `warden host add …` line to run on the laptop */
	add: string;
	/** resolves when sshd (or the dial-out) exits */
	exited: Promise<number>;
	stop: () => Promise<void>;
};

export function sshdConfig(p: { listen: string; port: number; dir: string }): string {
	return [
		`ListenAddress ${p.listen}`,
		`Port ${p.port}`,
		`HostKey ${join(p.dir, "ssh_host_ed25519_key")}`,
		`AuthorizedKeysFile ${join(p.dir, "authorized_keys")}`,
		`PidFile ${join(p.dir, "sshd.pid")}`,
		"UsePAM no",
		"StrictModes no",
		"PubkeyAuthentication yes",
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"PermitRootLogin no",
		"PermitUserEnvironment no",
		"AllowAgentForwarding no",
		"AllowTcpForwarding yes",
		"X11Forwarding no",
		"PermitTunnel no",
		"ClientAliveInterval 15",
		"ClientAliveCountMax 3",
		"LogLevel INFO",
		"",
	].join("\n");
}

/** The dial-out to a bastion: its loopback `remotePort` forwards to this sshd. */
export function dialArgv(jump: AttachJump, localPort: number): string[] {
	return [
		"ssh",
		"-N",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"StrictHostKeyChecking=accept-new",
		...(jump.identity !== undefined ? ["-i", jump.identity, "-o", "IdentitiesOnly=yes"] : []),
		"-R",
		`${jump.remotePort}:127.0.0.1:${localPort}`,
		jump.target,
	];
}

export function attachAddLine(p: {
	name: string;
	user: string;
	hostname: string;
	port: number;
	hostKey: string;
	jump?: string;
}): string {
	return [
		"warden host add",
		p.name,
		"--ssh",
		`${p.user}@${p.hostname}:${p.port}`,
		...(p.jump !== undefined ? ["--jump", p.jump] : []),
		"--host-key",
		shellQuote(p.hostKey),
		"--granted",
	].join(" ");
}

function freePort(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/** The forced command's warden, with this `WARDEN_HOME` baked in (sshd hands sessions a clean env). */
function writeWrapper(dir: string, home: string, warden: readonly string[]): string {
	const path = join(dir, "warden");
	const cmd = warden.map(shellQuote).join(" ");
	writeFileSync(path, `#!/bin/sh\nexec env WARDEN_HOME=${shellQuote(home)} ${cmd} "$@"\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Wait for sshd's "Server listening" line, or its exit; keeps draining stderr after. */
async function listening(stderr: ReadableStream<Uint8Array>, exited: Promise<number>): Promise<Result<void>> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	const timeout = Bun.sleep(10_000).then(() => ({ done: true, value: undefined }));
	const gone = exited.then(() => ({ done: true, value: undefined }));
	for (;;) {
		const next = await Promise.race([reader.read(), gone, timeout]);
		if (next.done || next.value === undefined) return err(`sshd did not start: ${seen.trim() || "no output"}`);
		seen += decoder.decode(next.value);
		if (seen.includes("Server listening")) break;
	}
	void (async () => {
		for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
	})();
	return ok(undefined);
}

async function keygen(ctx: CommandContext, path: string): Promise<Result<string>> {
	if (!existsSync(path)) {
		const made = await ctx.exec(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "warden-attach", "-f", path]);
		if (made.exitCode !== 0) return err(`ssh-keygen: ${made.stderr.trim()}`);
	}
	return ok(readFileSync(`${path}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" "));
}

/** Set up and start the sshd (and the dial-out); `stop` ends both. */
export async function startAttach(ctx: CommandContext, opts: AttachOptions): Promise<Result<Attached>> {
	if (!existsSync(SSHD)) return err(`${SSHD} is missing: host attach needs OpenSSH's sshd`);
	const home = wardenHome(ctx.env);
	const dir = join(home, "attach");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const hostKey = await keygen(ctx, join(dir, "ssh_host_ed25519_key"));
	if (!hostKey.success) return hostKey;
	const authorized = join(dir, "authorized_keys");
	rmSync(authorized, { force: true });
	const wrapper = writeWrapper(dir, home, opts.warden ?? selfCommand());
	const granted = grantKey(ctx, { key: opts.grant, authorizedKeys: authorized, warden: wrapper }, ctx.now());
	if (!granted.success) return granted;
	const port = opts.port ?? (await freePort(opts.listen));
	writeFileSync(join(dir, "sshd_config"), sshdConfig({ listen: opts.listen, port, dir }));
	const sshd = Bun.spawn([SSHD, "-D", "-e", "-f", join(dir, "sshd_config")], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const up = await listening(sshd.stderr, sshd.exited);
	if (!up.success) {
		sshd.kill();
		return up;
	}
	const dial = opts.jump
		? Bun.spawn(dialArgv(opts.jump, port), { stdin: "ignore", stdout: "ignore", stderr: "inherit" })
		: undefined;
	// a user-level sshd lets in only the user it runs as
	const user = userInfo().username;
	const add = attachAddLine({
		name: opts.name,
		user,
		hostname: opts.jump ? "127.0.0.1" : (opts.advertise ?? opts.listen),
		port: opts.jump ? opts.jump.remotePort : port,
		hostKey: hostKey.data,
		...(opts.jump ? { jump: opts.jump.target } : {}),
	});
	const exited = Promise.race([sshd.exited, ...(dial ? [dial.exited] : [])]);
	return ok({
		port,
		hostKey: hostKey.data,
		add,
		exited,
		stop: async () => {
			dial?.kill();
			sshd.kill();
			await Promise.all([sshd.exited, dial?.exited]);
		},
	});
}
