import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wardenHome } from "../store";
import type { ProxyHandle } from "./control";

/** `$WARDEN_HOME/netproxy/<leaseId>.json`: how another warden process finds a lease's proxy. */
export function handlePath(leaseId: string, env: Record<string, string | undefined> = process.env): string {
	return join(wardenHome(env), "netproxy", `${leaseId}.json`);
}

/** What `netproxy.main.ts` writes once it is listening. `portLeaseId` is added by `ensureLeaseProxy`. */
export type HandleFile = ProxyHandle & { leaseId: string; portLeaseId?: string };

/** Atomic (tmp + rename) and owner-only: the file carries the control token. */
export function writeHandleFile(path: string, data: HandleFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
	renameSync(tmp, path);
}

export function readHandleFile(path: string): HandleFile | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as HandleFile;
	} catch {
		return undefined;
	}
}

export function removeHandleFile(path: string): void {
	rmSync(path, { force: true });
}
