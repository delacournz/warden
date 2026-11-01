import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";
import type { ProxyHandle } from "./control";

/** What `netproxy.main.ts` writes once it is listening. `portLeaseId` is added by `ensureLeaseProxy`. */
export type HandleFile = ProxyHandle & { leaseId: string; portLeaseId?: string };

/** Handle files: how another warden process finds a lease's proxy. */
export class HandleFiles {
	/** `$WARDEN_HOME/netproxy/<leaseId>.json`: how another warden process finds a lease's proxy. */
	path(leaseId: string, env: Record<string, string | undefined> = process.env): string {
		return join(storeLocator.wardenHome(env), "netproxy", `${leaseId}.json`);
	}

	/** Atomic (tmp + rename) and owner-only: the file carries the control token. */
	write(path: string, data: HandleFile): void {
		mkdirSync(join(path, ".."), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
		renameSync(tmp, path);
	}

	read(path: string): HandleFile | undefined {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as HandleFile;
		} catch {
			return undefined;
		}
	}

	remove(path: string): void {
		rmSync(path, { force: true });
	}
}

export const handleFiles = new HandleFiles();
