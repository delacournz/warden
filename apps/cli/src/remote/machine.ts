import { createHmac } from "node:crypto";
import type { Exec } from "@delacour/warden-core/exec";
import type { CommandContext } from "../context";

/** HMAC key the CLI hashes the OS machine id with; the server re-hashes the result with its own pepper. */
export const MACHINE_HASH_KEY = "warden-machine-v1";

/** What reading the machine id touches; `readFile` resolves `undefined` for a missing file. */
export type MachineDeps = {
	os: NodeJS.Platform;
	env: Record<string, string | undefined>;
	exec: Exec;
	readFile: (path: string) => Promise<string | undefined>;
};

export type MachineSource = "ioreg" | "registry" | "machine-id";

export type MachineId = { kind: "found"; id: string; source: MachineSource } | { kind: "none"; reason: string };

export type MachineHash = { kind: "found"; hash: string; source: MachineSource } | { kind: "none"; reason: string };

const IOREG = ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"];
const REG = ["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"];
const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

/** An id worth hashing: long enough and not a placeholder (all zeros, `uninitialized`). */
function usable(raw: string | undefined): string | undefined {
	const id = raw?.trim().toLowerCase();
	if (!id || id.length < 8 || !/^[0-9a-f-]+$/.test(id) || /^[0-]+$/.test(id)) return undefined;
	return id;
}

async function run(exec: Exec, cmd: readonly string[]): Promise<string | undefined> {
	const r = await exec(cmd, { timeoutMs: 5000 }).catch(() => undefined);
	return r?.exitCode === 0 ? r.stdout : undefined;
}

async function readIoreg(deps: MachineDeps): Promise<string | undefined> {
	return usable((await run(deps.exec, IOREG))?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]);
}

async function readRegistry(deps: MachineDeps): Promise<string | undefined> {
	return usable((await run(deps.exec, REG))?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1]);
}

async function readMachineIdFile(deps: MachineDeps): Promise<string | undefined> {
	for (const path of MACHINE_ID_FILES) {
		const id = usable(await deps.readFile(path).catch(() => undefined));
		if (id) return id;
	}
	return undefined;
}

const READERS: Partial<Record<NodeJS.Platform, { source: MachineSource; read: typeof readIoreg }>> = {
	darwin: { source: "ioreg", read: readIoreg },
	win32: { source: "registry", read: readRegistry },
	linux: { source: "machine-id", read: readMachineIdFile },
};

/** The OS's stable machine id (macOS IOPlatformUUID, Windows MachineGuid, Linux machine-id); CI never reads one. */
export async function readMachineId(deps: MachineDeps): Promise<MachineId> {
	if (deps.env.CI) return { kind: "none", reason: "ci" };
	const reader = READERS[deps.os];
	if (!reader) return { kind: "none", reason: `unsupported os ${deps.os}` };
	const id = await reader.read(deps);
	return id ? { kind: "found", id, source: reader.source } : { kind: "none", reason: `no ${reader.source} id` };
}

/** HMAC-SHA256(`warden-machine-v1`, id) as 64 hex chars: the only form of the id that leaves the machine. */
export function hashMachineId(id: string): string {
	return createHmac("sha256", MACHINE_HASH_KEY).update(id).digest("hex");
}

export async function machineHash(deps: MachineDeps): Promise<MachineHash> {
	const id = await readMachineId(deps);
	return id.kind === "found" ? { kind: "found", hash: hashMachineId(id.id), source: id.source } : id;
}

/** File reads for `MachineDeps` off the real disk. */
export async function readTextFile(path: string): Promise<string | undefined> {
	const file = Bun.file(path);
	return (await file.exists()) ? file.text() : undefined;
}

/** `MachineDeps` off a command's context: its OS, env and exec, and the disk unless the context overrides reads. */
export function machineDepsFor(ctx: CommandContext): MachineDeps {
	return { os: ctx.os ?? process.platform, env: ctx.env, exec: ctx.exec, readFile: ctx.readFile ?? readTextFile };
}
