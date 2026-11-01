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

/** The cache behind `ImportCaches.open`: entries in memory, one JSON file when `path` is set. */
class FileImportCache implements ImportCache {
	private entries: Record<string, Entry> = {};
	private dirty = false;

	constructor(private readonly path?: string) {
		if (!path) return;
		try {
			const doc = JSON.parse(readFileSync(path, "utf8"));
			this.entries = doc?.version === CACHE_VERSION && doc.files ? doc.files : {};
		} catch {
			this.entries = {};
		}
	}

	readonly get = (file: string): string[] | undefined => {
		const hit = this.entries[file];
		const now = hit && this.stamp(file);
		return hit && now && now.mtimeMs === hit.mtimeMs && now.size === hit.size ? hit.specs : undefined;
	};

	readonly set = (file: string, specs: string[]): void => {
		const now = this.stamp(file);
		if (!now) return;
		this.entries[file] = { ...now, specs };
		this.dirty = true;
	};

	readonly save = (): void => {
		if (!this.path || !this.dirty) return;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({ version: CACHE_VERSION, files: this.entries }));
		this.dirty = false;
	};

	private stamp(file: string): { mtimeMs: number; size: number } | undefined {
		try {
			const s = statSync(file);
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			return undefined;
		}
	}
}

export class ImportCaches {
	/** `path` undefined = in-memory only. A missing or corrupt cache file starts empty. */
	open(path?: string): ImportCache {
		return new FileImportCache(path);
	}
}

export const importCaches = new ImportCaches();
