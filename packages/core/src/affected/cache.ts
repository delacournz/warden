import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Entry = { mtimeMs: number; size: number; specs: string[] };

/** Bump when what is stored per file changes (e.g. how imports are scanned). */
const CACHE_VERSION = 2;

/** Import specifiers per file, valid while mtime + size match; persisted as one JSON file. */
export type ImportCache = {
	get: (file: string) => string[] | undefined;
	set: (file: string, specs: string[]) => void;
	save: () => void;
};

function stamp(file: string): { mtimeMs: number; size: number } | undefined {
	try {
		const s = statSync(file);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return undefined;
	}
}

/** `path` undefined = in-memory only. A missing or corrupt cache file starts empty. */
export function openImportCache(path?: string): ImportCache {
	let entries: Record<string, Entry> = {};
	if (path) {
		try {
			const doc = JSON.parse(readFileSync(path, "utf8"));
			entries = doc?.version === CACHE_VERSION && doc.files ? doc.files : {};
		} catch {
			entries = {};
		}
	}
	let dirty = false;
	return {
		get: (file) => {
			const hit = entries[file];
			const now = hit && stamp(file);
			return hit && now && now.mtimeMs === hit.mtimeMs && now.size === hit.size ? hit.specs : undefined;
		},
		set: (file, specs) => {
			const now = stamp(file);
			if (!now) return;
			entries[file] = { ...now, specs };
			dirty = true;
		},
		save: () => {
			if (!path || !dirty) return;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ version: CACHE_VERSION, files: entries }));
			dirty = false;
		},
	};
}
