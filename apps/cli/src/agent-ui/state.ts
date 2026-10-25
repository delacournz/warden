import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DumpRoute } from "@delacour/warden-e2e/driver/android/android-dump";
import type { Element, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { z } from "zod";
import type { CommandContext } from "../context";
import { uiDir } from "./paths";

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

/** `state.json`. `generation` bumps only on `snapshot`, `snapshot --settle` and `find`. */
export type UiState = {
	generation: number;
	metroUrl?: string;
	/** bundle id of the app `warden ui open` last launched (`close --app` terminates it) */
	app?: string;
	helper?: HelperRecord;
	/** the running `logs start` collector (`warden ui-collect`): host pid, start time and (newer warden) its `--out` dir */
	collector?: { pid: number; startedAt: number; out?: string };
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

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const pointSchema = z.object({ x: z.number(), y: z.number() });

const elementSchema: z.ZodType<Element> = z.lazy(() =>
	z.object({
		id: z.string(),
		role: z.custom<Element["role"]>((value) => typeof value === "string"),
		rawType: z.string(),
		label: z.string().optional(),
		identifier: z.string().optional(),
		value: z.string().optional(),
		text: z.string().optional(),
		placeholder: z.string().optional(),
		frame: rectSchema,
		normFrame: rectSchema,
		traits: z.array(z.string()),
		enabled: z.boolean(),
		focused: z.boolean().optional(),
		hidden: z.boolean().optional(),
		selected: z.boolean().optional(),
		checked: z.boolean().optional(),
		hittable: z.boolean().optional(),
		tapPoint: pointSchema.optional(),
		pid: z.number().optional(),
		depth: z.number(),
		children: z.array(elementSchema),
	})
);

const storedSnapshotSchema = z.object({
	generation: z.number(),
	takenAt: z.number(),
	hash: z.string(),
	snapshot: z.object({
		platform: z.enum(["ios", "android"]),
		backend: z.enum(["axbridge", "ax", "uiautomator"]),
		takenAt: z.number(),
		screen: z.object({
			width: z.number(),
			height: z.number(),
			scale: z.number(),
			rotation: z.number().optional(),
		}),
		elements: z.array(elementSchema),
		truncated: z.boolean(),
		modal: z.object({ pid: z.number().optional(), description: z.string().optional() }).optional(),
	}),
});

const stateSchema = z.object({
	generation: z.number(),
	metroUrl: z.string().optional(),
	app: z.string().optional(),
	helper: z
		.object({
			pid: z.number(),
			socket: z.string(),
			owner: z.string().optional(),
			binary: z.object({ path: z.string(), mtimeMs: z.number() }).optional(),
			env: z.string().optional(),
			lease: z.string().optional(),
		})
		.optional(),
	collector: z.object({ pid: z.number(), startedAt: z.number(), out: z.string().optional() }).optional(),
	video: z
		.object({ pid: z.number(), path: z.string(), remote: z.string().optional(), startedAt: z.number() })
		.optional(),
	updatedAt: z.number().optional(),
});

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

export function preorder(elements: readonly Element[]): Element[] {
	return elements.flatMap((element) => [element, ...preorder(element.children)]);
}

const generationKey = (udid: string): string => `ui_generation:${udid}`;

/** `state.json`; with a store in `ctx`, `generation` is the store's counter (the source of truth, see `commitGeneration`). */
export function readState(
	ctx: Pick<CommandContext, "env"> & Partial<Pick<CommandContext, "store">>,
	udid: string
): UiState {
	const parsed = stateSchema.safeParse(readJson(join(uiDir(ctx, udid), "state.json")));
	const state = parsed.success ? { ...EMPTY_STATE, ...parsed.data } : { ...EMPTY_STATE };
	const stored = Number(ctx.store?.().getMeta(generationKey(udid)));
	return Number.isFinite(stored) && stored > state.generation ? { ...state, generation: stored } : state;
}

export function writeState(ctx: Pick<CommandContext, "env" | "now">, udid: string, state: UiState): void {
	const dir = uiDir(ctx, udid);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(join(dir, "state.json"), `${JSON.stringify({ ...state, updatedAt: ctx.now() }, null, 2)}\n`);
}

/**
 * Read-modify-write of `state.json`: re-reads the file and writes what `update` returns, all under the store's
 * `BEGIN IMMEDIATE` transaction (the cross-process mutex), so two `warden ui` processes setting different records
 * (helper, video, collector, app) never lose each other's. Every `state.json` writer goes through here.
 * `update` must not block (it runs inside the transaction); returning the state it was given writes nothing.
 * Without a store in `ctx` it is a plain read-modify-write. Returns the state as it now stands.
 */
export function updateState(
	ctx: Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store">>,
	udid: string,
	update: (state: UiState) => UiState
): UiState {
	const apply = (): UiState => {
		const current = readState(ctx, udid);
		const next = update(current);
		if (next === current) return current;
		writeState(ctx, udid, next);
		return { ...next, updatedAt: ctx.now() };
	};
	return ctx.store === undefined ? apply() : ctx.store().transaction(apply);
}

/**
 * Takes the device's next generation number and runs `write` with it, all under the store's `BEGIN IMMEDIATE`
 * transaction (the cross-process mutex), so two `warden ui` processes never share a generation and the stored
 * snapshot always carries the highest one. The counter lives in a store meta row (`ui_generation:<udid>`); a
 * `state.json` from before it existed seeds it. Called once per `snapshot` / `snapshot --settle` / `find` / `wait`.
 */
export function commitGeneration<T>(
	ctx: Pick<CommandContext, "env" | "store">,
	udid: string,
	write: (generation: number) => T
): T {
	const store = ctx.store();
	return store.transaction(() => {
		const generation = readState(ctx, udid).generation + 1;
		store.setMeta(generationKey(udid), String(generation));
		return write(generation);
	});
}

export function readLastSnapshot(ctx: Pick<CommandContext, "env">, udid: string): StoredSnapshot | undefined {
	const parsed = storedSnapshotSchema.safeParse(readJson(join(uiDir(ctx, udid), "last-snapshot.json")));
	if (!parsed.success) return undefined;
	const file: StoredSnapshotFile = parsed.data;
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
