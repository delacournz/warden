import type { Store } from "../store";
import type { Platform } from "../types";
import { type BuildRecord, cachedBuild } from "./cache";

/** `<nativeFp>` or `<nativeFp>:dev` → the fingerprint and the dev kind's cache hash (`kindHash` of a dev key). */
export function devBuildHash(hash: string): { nativeFp: string; hash: string } {
	const nativeFp = hash.replace(/:dev$/, "");
	return { nativeFp, hash: `${nativeFp}:dev` };
}

export type DevBuildQuery = {
	projectKey: string;
	platform: Platform;
	/** `<nativeFp>` or `<nativeFp>:dev` */
	hash: string;
	/** the project's kind-less build is its dev build (`kindlessIsDev`): a kind-less row of the fingerprint is that build too */
	kindlessIsDev: boolean;
	now: number;
};

/**
 * The cached dev build `warden app ensure --kind dev` would install, without building, downloading or writing a row: the
 * dev row of the fingerprint, else (when the plain build is the dev build) a kind-less / legacy row of it. Rows whose
 * files are gone are dropped by `cachedBuild`.
 */
export function findDevBuild(store: Store, query: DevBuildQuery): BuildRecord | undefined {
	const { projectKey, platform, now } = query;
	const { nativeFp, hash } = devBuildHash(query.hash);
	const dev = cachedBuild(store, projectKey, platform, hash, now);
	if (dev) return dev;
	if (!query.kindlessIsDev) return undefined;
	const plain = cachedBuild(store, projectKey, platform, nativeFp, now);
	return plain && (plain.kind === undefined || plain.kind === "legacy") ? plain : undefined;
}
