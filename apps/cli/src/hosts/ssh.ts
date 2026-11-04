import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ClaimErrorCode } from "@delacour/warden-core/claim-errors";
import type { HostRecord, SshTarget } from "@delacour/warden-core/hosts/registry";
import { err, ok, type Result } from "@delacour/warden-types/result";

/** Where a host's pinned `known_hosts` and the shared control sockets live under `$WARDEN_HOME`. */
export function hostKnownHosts(home: string, name: string): string {
	return join(home, "hosts", `${name}.known_hosts`);
}

export function hostControlDir(home: string): string {
	return join(home, "hosts", "cm");
}

/** macOS caps a unix socket path at 104 bytes; the name is `<8 hex>-%C`, and `%C` expands to 40 hex characters. */
const SOCKET_PATH_MAX = 104;
const CONTROL_NAME_LEN = 50;

/**
 * The control socket's name. `%C` hashes host, port and user but not the key, so it carries the identity too: the
 * setup shell key's master must never carry a granted key's calls (those must go through the forced command).
 */
function controlName(identity: string | undefined): string {
	return `${createHash("sha256")
		.update(identity ?? "")
		.digest("hex")
		.slice(0, 8)}-%C`;
}

const HOSTNAME = /^[A-Za-z0-9._:%[\]-]+$/;
const USER = /^[A-Za-z0-9._-]+$/;

/** `user@hostname[:port]` → its parts; refuses anything ssh could read as an option. */
export function parseSshTarget(raw: string): Result<SshTarget> {
	const at = raw.lastIndexOf("@");
	const user = at >= 0 ? raw.slice(0, at) : undefined;
	let rest = at >= 0 ? raw.slice(at + 1) : raw;
	let port: number | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon > 0 && !rest.startsWith("[") && rest.indexOf(":") === colon) {
		const value = rest.slice(colon + 1);
		port = Number(value);
		if (!/^\d+$/.test(value) || port < 1 || port > 65535) return err(`--ssh ${raw}: bad port ${value}`);
		rest = rest.slice(0, colon);
	}
	if (rest === "" || rest.startsWith("-") || !HOSTNAME.test(rest)) return err(`--ssh ${raw}: not user@host[:port]`);
	if (user !== undefined && (user === "" || !USER.test(user))) return err(`--ssh ${raw}: bad user`);
	return ok({ ...(user !== undefined ? { user } : {}), hostname: rest, ...(port !== undefined ? { port } : {}) });
}

export function formatSshTarget(target: SshTarget): string {
	return `${target.user !== undefined ? `${target.user}@` : ""}${target.hostname}${target.port !== undefined ? `:${target.port}` : ""}`;
}

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** One word for a POSIX shell: as is when safe, else single-quoted. */
export function shellQuote(word: string): string {
	if (word !== "" && SAFE_WORD.test(word)) return word;
	return `'${word.replaceAll("'", "'\\''")}'`;
}

/** The words of a command line as a POSIX shell splits them (quotes and backslashes; no expansion). */
export function shellSplit(line: string): Result<string[]> {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let i = 0;
	while (i < line.length) {
		const c = line[i] ?? "";
		if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) return err("unterminated single quote");
			word += line.slice(i + 1, end);
			inWord = true;
			i = end + 1;
		} else if (c === '"') {
			let j = i + 1;
			for (; j < line.length && line[j] !== '"'; j++) {
				if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1] ?? "")) j++;
				word += line[j];
			}
			if (j >= line.length) return err("unterminated double quote");
			inWord = true;
			i = j + 1;
		} else if (c === "\\" && i + 1 < line.length) {
			word += line[i + 1];
			inWord = true;
			i += 2;
		} else if (c === " " || c === "\t" || c === "\n") {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
			i++;
		} else {
			word += c;
			inWord = true;
			i++;
		}
	}
	if (inWord) words.push(word);
	return ok(words);
}

export type SshArgvOptions = {
	home: string;
	/** first contact: pin the host key ssh is shown (`accept-new`), never accept a changed one */
	trustNew?: boolean;
	/** share one connection per host for 60 s (default true); a long-lived stdio channel skips it */
	control?: boolean;
	/** `-R` / `-L` / `-N` arguments (warden dev --host) */
	forwards?: readonly string[];
};

/**
 * `ssh … <target> -- <cmd…>` for a host: key auth only (`BatchMode`), the host key checked against the one pinned
 * for it (`StrictHostKeyChecking=yes`, its own `known_hosts`), no agent or X11 forwarding, no tty, keepalives so a
 * dead link is noticed in ~45 s, and one shared connection per host. Each word of `cmd` is quoted for the remote shell.
 */
export function sshArgv(host: HostRecord, cmd: readonly string[], opts: SshArgvOptions): string[] {
	const argv = [
		"ssh",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		`StrictHostKeyChecking=${opts.trustNew ? "accept-new" : "yes"}`,
		"-o",
		`UserKnownHostsFile=${hostKnownHosts(opts.home, host.name)}`,
		"-o",
		"GlobalKnownHostsFile=/dev/null",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ForwardX11=no",
		"-o",
		"ConnectTimeout=15",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"LogLevel=ERROR",
	];
	if (host.identity !== undefined) argv.push("-i", host.identity, "-o", "IdentitiesOnly=yes");
	const controlDir = hostControlDir(opts.home);
	if (opts.control !== false && controlDir.length + 1 + CONTROL_NAME_LEN < SOCKET_PATH_MAX) {
		argv.push(
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${join(controlDir, controlName(host.identity))}`,
			"-o",
			"ControlPersist=60s"
		);
	}
	if (host.proxyCommand !== undefined) argv.push("-o", `ProxyCommand=${host.proxyCommand}`);
	if (host.jump !== undefined) argv.push("-J", host.jump);
	argv.push(...(opts.forwards ?? []));
	if (host.ssh.port !== undefined) argv.push("-p", String(host.ssh.port));
	argv.push(host.ssh.user !== undefined ? `${host.ssh.user}@${host.ssh.hostname}` : host.ssh.hostname);
	argv.push("--", ...cmd.map(shellQuote));
	return argv;
}

const AUTH_FAILURE =
	/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* (?:not known|differs)|Too many authentication failures/i;

/** What an ssh exit means for warden: 255 is ssh's own failure (auth vs reach); any other code is the remote command's. */
export function classifySshFailure(
	exitCode: number,
	stderr: string
): Extract<ClaimErrorCode, "HOST_AUTH" | "HOST_UNREACHABLE"> | undefined {
	if (exitCode !== 255) return undefined;
	return AUTH_FAILURE.test(stderr) ? "HOST_AUTH" : "HOST_UNREACHABLE";
}
