import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store";

/**
 * Ownership marker: warden writes `.warden-owned.json` into the device dir of every iOS simulator it creates,
 * naming the host instance (a random id kept in the store `meta`) that made it. Destructive paths (shutdown on
 * release, erase, delete) refuse a sim whose marker names another instance: a second `WARDEN_HOME` or user
 * account on the same machine owns it. A sim with no marker keeps today's rules. Android emulators are AVDs
 * launched from a shared definition, not created per claim, so they carry no marker.
 */

export const MARKER_FILE = ".warden-owned.json";
export const INSTANCE_META_KEY = "instance_id";

export type OwnershipMarker = { instanceId: string; name: string; createdAt: number };

/** The filesystem the marker lives on, injectable for tests. */
export type MarkerFs = {
	readText: (path: string) => string | undefined;
	writeText: (path: string, text: string) => void;
	isDir: (path: string) => boolean;
};

export const realMarkerFs: MarkerFs = {
	readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	writeText: (path, text) => writeFileSync(path, text),
	isDir: (path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
};

type Env = Record<string, string | undefined>;

/** This host's stable instance id: created on first use inside a transaction, then read from `meta`. */
export function instanceId(store: Store): string {
	const known = store.getMeta(INSTANCE_META_KEY);
	if (known !== undefined) return known;
	return store.transaction(() => {
		const again = store.getMeta(INSTANCE_META_KEY);
		if (again !== undefined) return again;
		const fresh = randomUUID();
		store.setMeta(INSTANCE_META_KEY, fresh);
		return fresh;
	});
}

/** `~/Library/Developer/CoreSimulator/Devices/<udid>` (the default device set); undefined without `HOME`. */
export function simDeviceDir(env: Env, udid: string): string | undefined {
	return env.HOME ? join(env.HOME, "Library/Developer/CoreSimulator/Devices", udid) : undefined;
}

export type MarkerRead = { kind: "absent" } | { kind: "present"; marker: OwnershipMarker } | { kind: "unreadable" };

export function readMarker(fs: MarkerFs, env: Env, udid: string): MarkerRead {
	const dir = simDeviceDir(env, udid);
	if (dir === undefined) return { kind: "absent" };
	let text: string | undefined;
	try {
		text = fs.readText(join(dir, MARKER_FILE));
	} catch {
		return { kind: "unreadable" };
	}
	if (text === undefined) return { kind: "absent" };
	try {
		const v: unknown = JSON.parse(text);
		if (typeof v !== "object" || v === null) return { kind: "unreadable" };
		const id = "instanceId" in v ? v.instanceId : undefined;
		const name = "name" in v ? v.name : undefined;
		const createdAt = "createdAt" in v ? v.createdAt : undefined;
		if (typeof id !== "string" || typeof name !== "string" || typeof createdAt !== "number") {
			return { kind: "unreadable" };
		}
		return { kind: "present", marker: { instanceId: id, name, createdAt } };
	} catch {
		return { kind: "unreadable" };
	}
}

/** Best-effort: only into a device dir that exists, and a failure never fails the create. */
export function writeMarker(fs: MarkerFs, env: Env, store: Store, udid: string, name: string, now: number): boolean {
	const dir = simDeviceDir(env, udid);
	if (dir === undefined) return false;
	try {
		if (!fs.isDir(dir)) return false;
		const marker: OwnershipMarker = { instanceId: instanceId(store), name, createdAt: now };
		fs.writeText(join(dir, MARKER_FILE), `${JSON.stringify(marker)}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Why a destructive step must leave this sim alone, else undefined: its marker names another warden instance.
 * A missing or unreadable marker blocks nothing (sims made before markers existed).
 */
export function markerBlock(fs: MarkerFs, env: Env, store: Store, udid: string): string | undefined {
	const read = readMarker(fs, env, udid);
	if (read.kind !== "present") return undefined;
	if (read.marker.instanceId === instanceId(store)) return undefined;
	return `${udid} is owned by another warden instance (${read.marker.instanceId}): left alone`;
}
