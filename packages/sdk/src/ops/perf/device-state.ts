import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";
import { uiDir } from "../paths";
import type { PerfEnv } from "./env";

/** Write `text` to `path` through a sibling temp file + rename, so readers never see half a file. */
export function writeFileAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

type StateFile = Record<string, unknown>;

const stateFile = (env: Pick<PerfEnv, "env">, udid: string): string =>
	join(uiDir(storeLocator.wardenHome(env.env), udid), "state.json");

function readStateFile(path: string): StateFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
	} catch {
		return {};
	}
}

/** The perf session the device's `state.json` points at (`perf.sessionId`), if any. */
export function readPerfPointer(env: Pick<PerfEnv, "env">, udid: string): string | undefined {
	const perf = readStateFile(stateFile(env, udid)).perf;
	if (typeof perf !== "object" || perf === null || !("sessionId" in perf)) return undefined;
	return typeof perf.sessionId === "string" ? perf.sessionId : undefined;
}

/**
 * Point the device's `state.json` at a perf session (or clear the pointer with `undefined`), keeping every other key
 * as it is, under the store's transaction like every other `state.json` writer.
 */
export function setPerfPointer(
	env: Pick<PerfEnv, "env" | "now" | "store">,
	udid: string,
	sessionId: string | undefined
): void {
	env.store().transaction(() => {
		const path = stateFile(env, udid);
		const state = readStateFile(path);
		const { perf: _previous, ...rest } = state;
		const next: StateFile = {
			generation: 0,
			...rest,
			...(sessionId === undefined ? {} : { perf: { sessionId } }),
			updatedAt: env.now(),
		};
		mkdirSync(uiDir(storeLocator.wardenHome(env.env), udid), { recursive: true });
		writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
	});
}

/** The Metro URL `warden ui open --metro` remembered for the device, if any. */
export function readMetroUrl(env: Pick<PerfEnv, "env">, udid: string): string | undefined {
	const url = readStateFile(stateFile(env, udid)).metroUrl;
	return typeof url === "string" ? url : undefined;
}
