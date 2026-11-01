import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { z } from "zod";

/**
 * The device's resident `warden-simd`: its pid and socket, plus what it was started with. `binary` is the helper
 * executable (realpath + mtime) and `env` a hash of the `WARDEN_SIMD_*` environment it inherited: when either differs
 * at the next use the helper is replaced, not reused (unless `lease`, the lease it was spawned under, is still the
 * device's lease: a run never has its own helper replaced). `owner` is the lease owner at spawn (`ownerKey`), kept for
 * reference only. Fields are absent on records written by an older warden, which are not guessed at.
 */
export type HelperRecord = {
	pid: number;
	socket: string;
	owner?: string;
	binary?: { path: string; mtimeMs: number };
	env?: string;
	lease?: string;
};

const helperRecordSchema = z.object({
	pid: z.number(),
	socket: z.string(),
	owner: z.string().optional(),
	binary: z.object({ path: z.string(), mtimeMs: z.number() }).optional(),
	env: z.string().optional(),
	lease: z.string().optional(),
});

/** What the helper lifecycle needs of a host: where `$WARDEN_HOME` is (via `env`), the clock, and optionally the store mutex. */
export type HelperStateHost = {
	env: Record<string, string | undefined>;
	now: () => number;
	store?: () => Store;
};

/** `$WARDEN_HOME/ui/<udid>`: everything `warden ui` remembers about one device between invocations. */
function deviceDir(host: Pick<HelperStateHost, "env">, udid: string): string {
	return join(storeLocator.wardenHome(host.env), "ui", udid);
}

/** `$WARDEN_HOME/simd`: the resident `warden-simd` helpers' sockets and logs. */
export function simdDir(host: Pick<HelperStateHost, "env">): string {
	return join(storeLocator.wardenHome(host.env), "simd");
}

function readRaw(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(Object.entries(parsed))
			: {};
	} catch {
		return {};
	}
}

/** The helper `state.json` records for `udid`, if any; any other shape is no record. */
export function readHelperRecord(host: Pick<HelperStateHost, "env">, udid: string): HelperRecord | undefined {
	const parsed = helperRecordSchema.safeParse(readRaw(join(deviceDir(host, udid), "state.json")).helper);
	if (!parsed.success) return undefined;
	const { owner, binary, env, lease, ...base } = parsed.data;
	return {
		...base,
		...(owner !== undefined ? { owner } : {}),
		...(binary !== undefined ? { binary } : {}),
		...(env !== undefined ? { env } : {}),
		...(lease !== undefined ? { lease } : {}),
	};
}

/**
 * Read-modify-write of the `helper` record in `state.json`, under the store's `BEGIN IMMEDIATE` transaction when the
 * host has a store (the cross-process mutex: two processes never lose each other's records). Every other key of the
 * file is kept as is. `update` returns the record to keep (`undefined` drops it); returning what it was given writes
 * nothing. `update` must not block.
 */
export function updateHelperRecord(
	host: HelperStateHost,
	udid: string,
	update: (record: HelperRecord | undefined) => HelperRecord | undefined
): void {
	const apply = (): void => {
		const dir = deviceDir(host, udid);
		const path = join(dir, "state.json");
		const current = readHelperRecord(host, udid);
		const next = update(current);
		if (next === current) return;
		const { helper: _drop, ...rest } = readRaw(path);
		const base = typeof rest.generation === "number" ? rest : { ...rest, generation: 0 };
		mkdirSync(dir, { recursive: true });
		const body = { ...base, ...(next !== undefined ? { helper: next } : {}), updatedAt: host.now() };
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
		renameSync(tmp, path);
	};
	if (host.store === undefined) apply();
	else host.store().transaction(apply);
}

/** Every device that has a socket under `simd/` or a dir under `ui/`. */
export function knownUdids(host: Pick<HelperStateHost, "env">): string[] {
	const udids = new Set<string>();
	const sockets = simdDir(host);
	if (existsSync(sockets)) {
		for (const name of readdirSync(sockets)) if (name.endsWith(".sock")) udids.add(basename(name, ".sock"));
	}
	const root = join(storeLocator.wardenHome(host.env), "ui");
	if (existsSync(root)) for (const name of readdirSync(root)) udids.add(name);
	return [...udids];
}
