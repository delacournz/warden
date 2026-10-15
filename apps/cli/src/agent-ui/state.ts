import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { DumpRoute } from "@delacour/warden-e2e/driver/android/android-dump";
import type { Element, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import type { CommandContext } from "../context";

/** `$WARDEN_HOME/ui/<udid>`: everything `warden ui` remembers about one device between invocations. */
export function uiDir(ctx: Pick<CommandContext, "env">, udid: string): string {
	return join(wardenHome(ctx.env), "ui", udid);
}

/** `state.json`. `generation` bumps only on `snapshot`, `snapshot --settle` and `find`. */
export type UiState = {
	generation: number;
	metroUrl?: string;
	/** bundle id of the app `warden ui open` last launched (`close --app` terminates it) */
	app?: string;
	/** the flow being recorded (`warden ui record start`) */
	recording?: { file: string; name: string; startedAt: number };
	helper?: { pid: number; socket: string };
	/** the running `logs start` collector (`warden ui-collect`): host pid and start time */
	collector?: { pid: number; startedAt: number };
	/** the running `video start` recorder: host pid, output file, and (Android) the file on the device */
	video?: { pid: number; path: string; remote?: string; startedAt: number };
	updatedAt: number;
};

/** `last-snapshot.json`: the tree the `@eN` refs of `generation` point into. `takenAt` is `ctx.now()` ms. */
export type StoredSnapshot = {
	generation: number;
	takenAt: number;
	hash: string;
	snapshot: Snapshot;
};

/** On disk `flat` is dropped (it aliases `elements`) and rebuilt on load. */
type StoredSnapshotFile = Omit<StoredSnapshot, "snapshot"> & { snapshot: Omit<Snapshot, "flat"> };

const EMPTY_STATE: UiState = { generation: 0, updatedAt: 0 };

/** Write `text` to `path` through a sibling temp file + rename, so readers never see half a file. */
export function writeFileAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function preorder(elements: readonly Element[]): Element[] {
	return elements.flatMap((element) => [element, ...preorder(element.children)]);
}

export function readState(ctx: Pick<CommandContext, "env">, udid: string): UiState {
	const raw = readJson(join(uiDir(ctx, udid), "state.json"));
	if (!isRecord(raw) || typeof raw.generation !== "number") return { ...EMPTY_STATE };
	// state.json is warden's own file; the generation check above is all a torn/foreign file must pass
	return { ...EMPTY_STATE, ...(raw as Partial<UiState>), generation: raw.generation };
}

export function writeState(ctx: Pick<CommandContext, "env" | "now">, udid: string, state: UiState): void {
	const dir = uiDir(ctx, udid);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(join(dir, "state.json"), `${JSON.stringify({ ...state, updatedAt: ctx.now() }, null, 2)}\n`);
}

/** Next generation number, persisted. Called once per `snapshot` / `snapshot --settle` / `find`. */
export function bumpGeneration(ctx: Pick<CommandContext, "env" | "now">, udid: string): number {
	const state = readState(ctx, udid);
	const generation = state.generation + 1;
	writeState(ctx, udid, { ...state, generation });
	return generation;
}

export function readLastSnapshot(ctx: Pick<CommandContext, "env">, udid: string): StoredSnapshot | undefined {
	const raw = readJson(join(uiDir(ctx, udid), "last-snapshot.json"));
	if (!isRecord(raw) || !isRecord(raw.snapshot) || !Array.isArray(raw.snapshot.elements)) return undefined;
	if (typeof raw.generation !== "number" || typeof raw.takenAt !== "number" || typeof raw.hash !== "string") {
		return undefined;
	}
	const file = raw as unknown as StoredSnapshotFile;
	return { ...file, snapshot: { ...file.snapshot, flat: preorder(file.snapshot.elements) } };
}

export function writeLastSnapshot(ctx: Pick<CommandContext, "env">, udid: string, stored: StoredSnapshot): void {
	const dir = uiDir(ctx, udid);
	mkdirSync(dir, { recursive: true });
	const { flat: _flat, ...snapshot } = stored.snapshot;
	const file: StoredSnapshotFile = { ...stored, snapshot };
	writeFileAtomic(join(dir, "last-snapshot.json"), JSON.stringify(file));
}

/** The Android uiautomator dump route that last worked on this device (`android-dump-route`), if remembered. */
export function readDumpRoute(ctx: Pick<CommandContext, "env">, udid: string): DumpRoute | undefined {
	try {
		const text = readFileSync(join(uiDir(ctx, udid), "android-dump-route"), "utf8").trim();
		return text === "stdout" || text === "tty" || text === "file" ? text : undefined;
	} catch {
		return undefined;
	}
}

/** Remember the working dump route; best effort (a read-only home just means re-probing next call). */
export function writeDumpRoute(ctx: Pick<CommandContext, "env">, udid: string, route: DumpRoute): void {
	try {
		const dir = uiDir(ctx, udid);
		mkdirSync(dir, { recursive: true });
		writeFileAtomic(join(dir, "android-dump-route"), `${route}\n`);
	} catch {
		// best effort
	}
}
