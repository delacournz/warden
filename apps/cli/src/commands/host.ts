import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deleteHost, type HostRecord, listGrants, listHosts, putHost } from "@delacour/warden-core/hosts/registry";
import { wardenHome } from "@delacour/warden-core/store";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { grantKey, revokeKey } from "../hosts/grant";
import { hostVersion, lookupHost, remoteFailure, wardenJson } from "../hosts/remote";
import { setupHost, type UploadFile } from "../hosts/setup";
import { formatSshTarget, hostKnownHosts, parseSshTarget } from "../hosts/ssh";
import { emit, note, reportError, success, table, warn } from "../output";
import { reportClaimFailure } from "../physical-lock";

/** What `warden host` reaches the outside world through beyond the context; tests inject the upload. */
export type HostDeps = { upload?: UploadFile };

const SCOPE = "host";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

type AddOpts = {
	ssh?: string;
	identity?: string;
	proxyCommand?: string;
	jump?: string;
	hostKey?: string;
	json?: true;
};

/** Record a host and make first contact (pins its host key; reads its warden version when one is installed). */
async function add(ctx: CommandContext, name: string, opts: AddOpts): Promise<number> {
	if (!NAME.test(name)) {
		reportError(ctx, SCOPE, `bad host name ${name}: letters, digits, . _ -`);
		return 1;
	}
	if (opts.ssh === undefined) {
		reportError(ctx, SCOPE, "--ssh user@host[:port] is required");
		return 1;
	}
	const target = parseSshTarget(opts.ssh);
	if (!target.success) {
		reportError(ctx, SCOPE, target.error);
		return 1;
	}
	const host: HostRecord = {
		name,
		ssh: target.data,
		...(opts.identity !== undefined ? { identity: opts.identity } : {}),
		...(opts.proxyCommand !== undefined ? { proxyCommand: opts.proxyCommand } : {}),
		...(opts.jump !== undefined ? { jump: opts.jump } : {}),
		...(opts.hostKey !== undefined ? { hostKey: opts.hostKey.trim() } : {}),
		addedAt: ctx.now(),
	};
	const knownHosts = hostKnownHosts(wardenHome(ctx.env), name);
	mkdirSync(dirname(knownHosts), { recursive: true, mode: 0o700 });
	rmSync(knownHosts, { force: true });
	if (host.hostKey !== undefined) {
		const label =
			target.data.port !== undefined ? `[${target.data.hostname}]:${target.data.port}` : target.data.hostname;
		writeFileSync(knownHosts, `${label} ${host.hostKey}\n`, { mode: 0o600 });
	}
	const version = await hostVersion(ctx, host, { trustNew: host.hostKey === undefined, allowSkew: true });
	if (!version.success && /HOST_(AUTH|UNREACHABLE)/.test(version.error)) {
		rmSync(knownHosts, { force: true });
		return reportClaimFailure(ctx, SCOPE, version.error);
	}
	const recorded: HostRecord = { ...host, ...(version.success ? { version: version.data } : {}) };
	putHost(ctx.store(), recorded);
	const text = version.success
		? `added ${name} (${formatSshTarget(target.data)}, warden ${version.data}); next: warden host setup ${name}`
		: `added ${name} (${formatSshTarget(target.data)}); warden is not set up there yet: warden host setup ${name}`;
	if (opts.json) emit(ctx, true, { host: recorded, warden: version.success ? version.data : null }, "");
	else success(ctx, text);
	return 0;
}

function hostRows(hosts: readonly HostRecord[]): string[][] {
	return hosts.map((h) => [
		h.name,
		formatSshTarget(h.ssh),
		h.version ?? "-",
		h.wardenPath !== undefined ? "yes" : "no",
		[h.jump !== undefined ? `jump ${h.jump}` : "", h.proxyCommand !== undefined ? "proxy" : ""]
			.filter(Boolean)
			.join(", ") || "-",
	]);
}

function ls(ctx: CommandContext, opts: { json?: true }): number {
	const hosts = listHosts(ctx.store());
	emit(
		ctx,
		opts.json === true,
		{ hosts },
		hosts.length === 0
			? "no hosts (warden host add <name> --ssh user@host)"
			: table(ctx, ["NAME", "SSH", "WARDEN", "SET UP", "VIA"], hostRows(hosts)),
		{ scope: SCOPE, detail: `${hosts.length} host(s)` }
	);
	return 0;
}

function rm(ctx: CommandContext, name: string, opts: { json?: true }): number {
	const held = ctx
		.store()
		.listLeases()
		.filter((l) => l.resource.kind === "host-device" && l.resource.host === name);
	if (held.length > 0) {
		reportError(
			ctx,
			SCOPE,
			`${name} still backs ${held.length} lease(s): release them first (warden release ${held.map((l) => l.id).join(" ")})`
		);
		return 1;
	}
	if (!deleteHost(ctx.store(), name)) return reportClaimFailure(ctx, SCOPE, `HOST_UNKNOWN: no host named ${name}`);
	rmSync(hostKnownHosts(wardenHome(ctx.env), name), { force: true });
	emit(ctx, opts.json === true, { removed: name }, `removed ${name}`);
	return 0;
}

type Check = { name: string; ok: boolean; detail: string };

/** Reach, auth and version (`version --json`), then the host's own lease drift report (`doctor --leases --json`). */
async function doctor(ctx: CommandContext, name: string, opts: { json?: true }): Promise<number> {
	const host = lookupHost(ctx, name);
	if (!host.success) return reportClaimFailure(ctx, SCOPE, host.error);
	const checks: Check[] = [];
	const version = await hostVersion(ctx, host.data);
	checks.push({ name: "warden", ok: version.success, detail: version.success ? version.data : version.error });
	let leases: unknown;
	if (version.success) {
		putHost(ctx.store(), { ...host.data, version: version.data });
		const ran = await wardenJson(ctx, host.data, ["doctor", "--leases", "--json"]);
		leases = ran.success ? ran.data.json : undefined;
		const failure = ran.success ? remoteFailure(ran.data.json) : { message: ran.error };
		checks.push({
			name: "leases",
			ok: ran.success && ran.data.exitCode === 0,
			detail: failure?.message ?? (ran.success && ran.data.exitCode === 0 ? "no drift" : "drift found"),
		});
	}
	const okAll = checks.every((c) => c.ok);
	emit(
		ctx,
		opts.json === true,
		{ host: name, ok: okAll, checks, leases },
		checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n"),
		{ scope: SCOPE, detail: name }
	);
	if (!version.success) return reportClaimFailure(ctx, SCOPE, version.error);
	return okAll ? 0 : 1;
}

type SetupOpts = {
	setupIdentity?: string;
	binary?: string;
	installDir?: string;
	authorizedKeys?: string;
	golden?: true;
	helper?: boolean;
	json?: true;
};

async function setup(ctx: CommandContext, deps: HostDeps, name: string, opts: SetupOpts): Promise<number> {
	const host = lookupHost(ctx, name);
	if (!host.success) return reportClaimFailure(ctx, SCOPE, host.error);
	const done = await setupHost(ctx, host.data, {
		...(opts.setupIdentity !== undefined ? { setupIdentity: opts.setupIdentity } : {}),
		...(opts.binary !== undefined ? { binary: opts.binary } : {}),
		...(opts.installDir !== undefined ? { installDir: opts.installDir } : {}),
		...(opts.authorizedKeys !== undefined ? { authorizedKeys: opts.authorizedKeys } : {}),
		...(opts.golden ? { golden: true } : {}),
		...(opts.helper === false ? { noHelper: true } : {}),
		...(deps.upload ? { upload: deps.upload } : {}),
		log: (line) => note(ctx, line),
	});
	if (!done.success) return reportClaimFailure(ctx, SCOPE, done.error);
	if (done.data.helper === "failed")
		warn(ctx, `${name}: the iOS helper could not be fetched (run warden doctor there)`);
	emit(
		ctx,
		opts.json === true,
		done.data,
		`${name} is set up: warden ${done.data.version} at ${done.data.wardenPath}, this laptop granted as ${done.data.machineId}`
	);
	return 0;
}

type GrantOpts = {
	key?: string;
	machine?: string;
	user?: string;
	authorizedKeys?: string;
	warden?: string;
	json?: true;
};

function grant(ctx: CommandContext, opts: GrantOpts): number {
	if (opts.key === undefined) {
		reportError(ctx, SCOPE, "--key <public key or .pub file> is required");
		return 1;
	}
	const granted = grantKey(
		ctx,
		{
			key: opts.key,
			...(opts.machine !== undefined ? { machine: opts.machine } : {}),
			...(opts.user !== undefined ? { user: opts.user } : {}),
			...(opts.authorizedKeys !== undefined ? { authorizedKeys: opts.authorizedKeys } : {}),
			...(opts.warden !== undefined ? { warden: opts.warden } : {}),
		},
		ctx.now()
	);
	if (!granted.success) {
		reportError(ctx, SCOPE, granted.error);
		return 1;
	}
	emit(
		ctx,
		opts.json === true,
		granted.data,
		`granted ${granted.data.user}@${granted.data.machineId} (${granted.data.fingerprint}) in ${granted.data.authorizedKeys}`
	);
	return 0;
}

function revoke(ctx: CommandContext, opts: { key?: string; authorizedKeys?: string; json?: true }): number {
	if (opts.key === undefined) {
		reportError(ctx, SCOPE, "--key <fingerprint, public key or .pub file> is required");
		return 1;
	}
	const revoked = revokeKey(ctx, {
		key: opts.key,
		...(opts.authorizedKeys !== undefined ? { authorizedKeys: opts.authorizedKeys } : {}),
	});
	if (!revoked.success) {
		reportError(ctx, SCOPE, revoked.error);
		return 1;
	}
	emit(ctx, opts.json === true, revoked.data, `revoked ${revoked.data.fingerprint}`);
	return 0;
}

function grants(ctx: CommandContext, opts: { json?: true }): number {
	const all = listGrants(ctx.store());
	emit(
		ctx,
		opts.json === true,
		{ grants: all },
		all.length === 0
			? "no laptops granted on this host"
			: table(
					ctx,
					["FINGERPRINT", "MACHINE", "USER"],
					all.map((g) => [g.fingerprint, g.machineId, g.user])
				)
	);
	return 0;
}

/**
 * `warden host`: drive the devices of another Mac over ssh. On the laptop: `add` / `ls` / `rm` / `doctor` /
 * `setup`. On the host: `grant` / `revoke` / `grants` (who may come in through the forced `__host-serve`).
 */
export function createHostCommand(deps: HostDeps = {}) {
	return defineCommand({
		name: "host",
		group: "Devices",
		summary: "drive another Mac's sims / emulators over ssh: add, setup, doctor, ls, rm (host side: grant, revoke)",
		register: (cmd, ctx, done) => {
			cmd
				.command("add")
				.description("record a Mac to drive over ssh and pin its host key (first contact)")
				.argument("<name>", "short name for the host")
				.option("--ssh <target>", "user@host[:port]")
				.option("--identity <file>", "ssh key for the setup shell (default: ssh's own)")
				.option("--proxy-command <cmd>", "ssh ProxyCommand (cloudflared, tailscale nc, an SSM bridge)")
				.option("--jump <host>", "ssh jump host (ProxyJump), for a host with no inbound")
				.option("--host-key <key>", "pin this host key (`ssh-ed25519 AAAA…`) instead of trusting the first one seen")
				.option("--json", "machine-readable output")
				.action(async (name, opts) => done(await add(ctx, name, opts)));
			cmd
				.command("setup")
				.description("install this warden on the host (no sudo), fetch its helper, grant this laptop's key")
				.argument("<name>", "host name")
				.option("--setup-identity <file>", "ssh key that opens a normal shell on the host (default: --identity)")
				.option("--binary <file>", "install this warden binary (a dev / local build) instead of the release")
				.option("--install-dir <dir>", "where warden goes on the host (default: ~/.local/bin)")
				.option("--authorized-keys <file>", "the host's authorized_keys (default: ~/.ssh/authorized_keys)")
				.option("--golden", "also build the iOS golden image there (minutes)")
				.option("--no-helper", "skip fetching the iOS driver helper there")
				.option("--json", "machine-readable output")
				.action(async (name, opts) => done(await setup(ctx, deps, name, opts)));
			cmd
				.command("doctor")
				.description("check a host: reachable, key accepted, same warden version, lease drift there")
				.argument("<name>", "host name")
				.option("--json", "machine-readable output")
				.action(async (name, opts) => done(await doctor(ctx, name, opts)));
			cmd
				.command("ls")
				.description("list hosts")
				.option("--json", "machine-readable output")
				.action((opts) => done(ls(ctx, opts)));
			cmd
				.command("rm")
				.description("forget a host")
				.argument("<name>", "host name")
				.option("--json", "machine-readable output")
				.action((name, opts) => done(rm(ctx, name, opts)));
			cmd
				.command("grant")
				.description("on the host: let a laptop key in, through the forced warden __host-serve")
				.option("--key <key>", "the laptop's public key line or .pub file (comment warden:<machine>:<user>)")
				.option("--machine <id>", "machine id when the key comment has none")
				.option("--user <name>", "user name when the key comment has none")
				.option("--authorized-keys <file>", "default ~/.ssh/authorized_keys")
				.option("--warden <path>", "the warden the forced command runs (default: this one)")
				.option("--json", "machine-readable output")
				.action((opts) => done(grant(ctx, opts)));
			cmd
				.command("revoke")
				.description("on the host: remove a laptop's grant and its authorized_keys line")
				.option("--key <key>", "fingerprint (SHA256:…), public key line or .pub file")
				.option("--authorized-keys <file>", "default ~/.ssh/authorized_keys")
				.option("--json", "machine-readable output")
				.action((opts) => done(revoke(ctx, opts)));
			cmd
				.command("grants")
				.description("on the host: list the laptops granted")
				.option("--json", "machine-readable output")
				.action((opts) => done(grants(ctx, opts)));
		},
	});
}

export const hostCommand = createHostCommand();
