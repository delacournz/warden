import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loopback sshd for integration tests (RMT-12): `/usr/sbin/sshd -D` on 127.0.0.1 as the current user, with a temp
 * host key, a temp `authorized_keys` whose every line carries a forced command, and a pinned `known_hosts`. Nothing
 * outside the temp dir is touched. Skipped where sshd is missing or `WARDEN_SSH_IT=0`.
 */

export const SSHD_PATH = "/usr/sbin/sshd";

/** Why the sshd integration tests cannot run here, or `undefined` when they can. */
export function sshdSkipReason(
	env: Record<string, string | undefined>,
	exists: (path: string) => boolean = existsSync
): string | undefined {
	if (env.WARDEN_SSH_IT === "0") return "WARDEN_SSH_IT=0";
	if (!exists(SSHD_PATH)) return `${SSHD_PATH} is missing`;
	return undefined;
}

export type SshClientKey = { path: string; publicKey: string };

export type SshArgvOptions = { identity?: SshClientKey; extra?: readonly string[] };

export type LoopbackSshd = {
	port: number;
	dir: string;
	/** the pinned known_hosts file every `sshArgv` uses */
	knownHosts: string;
	/** `ssh-ed25519 AAAA…` of the host key */
	hostPublicKey: string;
	/** the first client key (authorized with `forcedCommand`) */
	client: SshClientKey;
	/** a fresh client key authorized with its own forced command */
	addClient(opts: { forcedCommand: string }): Promise<SshClientKey>;
	/** `ssh … 127.0.0.1 -- <cmd…>` with strict host keys, batch mode, no agent */
	sshArgv(cmd: readonly string[], opts?: SshArgvOptions): string[];
	stop(): Promise<void>;
};

async function keygen(path: string): Promise<string> {
	const proc = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "warden-test", "-f", path], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0) throw new Error(`ssh-keygen failed: ${await new Response(proc.stderr).text()}`);
	return readFileSync(`${path}.pub`, "utf8").trim();
}

function authorizedLine(forcedCommand: string, publicKey: string): string {
	const escaped = forcedCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return `command="${escaped}",no-agent-forwarding,no-X11-forwarding,no-pty ${publicKey}\n`;
}

function freePort(): number {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const { port } = probe;
	probe.stop(true);
	return port;
}

/** Wait for sshd's "Server listening" line on stderr, or its exit. */
async function waitListening(proc: ReturnType<typeof Bun.spawn>, stderr: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const next = await Promise.race([
			reader.read(),
			proc.exited.then(() => ({ done: true, value: undefined })),
			Bun.sleep(5000).then(() => ({ done: true, value: undefined })),
		]);
		if (next.done || next.value === undefined) break;
		seen += decoder.decode(next.value);
		if (seen.includes("Server listening")) {
			// keep draining so sshd never blocks on a full pipe
			void (async () => {
				for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
			})();
			return "listening";
		}
	}
	return seen;
}

/** Start a loopback sshd; retries a port another process took between the probe and the bind. */
export async function startLoopbackSshd(opts: { forcedCommand: string }): Promise<LoopbackSshd> {
	const dir = mkdtempSync(join(tmpdir(), "wsshd-"));
	const hostKey = join(dir, "host_key");
	const hostPublicKey = (await keygen(hostKey)).split(" ").slice(0, 2).join(" ");
	const authorized = join(dir, "authorized_keys");
	const client: SshClientKey = { path: join(dir, "client_key"), publicKey: await keygen(join(dir, "client_key")) };
	writeFileSync(authorized, authorizedLine(opts.forcedCommand, client.publicKey));
	const knownHosts = join(dir, "known_hosts");
	const pidFile = join(dir, "sshd.pid");

	for (let attempt = 0; attempt < 3; attempt++) {
		const port = freePort();
		const config = join(dir, "sshd_config");
		writeFileSync(
			config,
			[
				"ListenAddress 127.0.0.1",
				`Port ${port}`,
				`HostKey ${hostKey}`,
				`AuthorizedKeysFile ${authorized}`,
				`PidFile ${pidFile}`,
				"UsePAM no",
				"StrictModes no",
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"PubkeyAuthentication yes",
				"AllowTcpForwarding yes",
				"AllowAgentForwarding no",
				"LogLevel ERROR",
				"",
			].join("\n")
		);
		const proc = Bun.spawn([SSHD_PATH, "-D", "-e", "-o", "LogLevel=INFO", "-f", config], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const outcome = await waitListening(proc, proc.stderr);
		if (outcome !== "listening") {
			proc.kill();
			await proc.exited;
			if (attempt === 2) {
				rmSync(dir, { recursive: true, force: true });
				throw new Error(`sshd did not start: ${outcome}`);
			}
			continue;
		}
		writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostPublicKey}\n`);
		let stopped = false;
		const sshArgv = (cmd: readonly string[], o: SshArgvOptions = {}): string[] => [
			"ssh",
			"-p",
			String(port),
			"-i",
			(o.identity ?? client).path,
			"-o",
			"BatchMode=yes",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			`UserKnownHostsFile=${knownHosts}`,
			"-o",
			"ForwardAgent=no",
			"-o",
			"LogLevel=ERROR",
			...(o.extra ?? []),
			"127.0.0.1",
			"--",
			...cmd,
		];
		return {
			port,
			dir,
			knownHosts,
			hostPublicKey,
			client,
			async addClient({ forcedCommand }) {
				const path = join(dir, `client_${Math.random().toString(36).slice(2, 8)}`);
				const key: SshClientKey = { path, publicKey: await keygen(path) };
				await appendFile(authorized, authorizedLine(forcedCommand, key.publicKey));
				return key;
			},
			sshArgv,
			async stop() {
				if (stopped) return;
				stopped = true;
				proc.kill();
				await proc.exited;
				rmSync(dir, { recursive: true, force: true });
			},
		};
	}
	throw new Error("unreachable");
}
