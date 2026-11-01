import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";
import { uiPaths } from "../paths";
import type { PerfEnv } from "./env";

type StateFile = Record<string, unknown>;

/** PerfDeviceState: device state. */
export class PerfDeviceState {
	/** Write `text` to `path` through a sibling temp file + rename, so readers never see half a file. */
	writeFileAtomic(path: string, text: string): void {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	}

	private readonly stateFile = (env: Pick<PerfEnv, "env">, udid: string): string =>
		join(uiPaths.uiDir(storeLocator.wardenHome(env.env), udid), "state.json");

	private readStateFile(path: string): StateFile {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
		} catch {
			return {};
		}
	}

	/** The perf session the device's `state.json` points at (`perf.sessionId`), if any. */
	readPerfPointer(env: Pick<PerfEnv, "env">, udid: string): string | undefined {
		const perf = this.readStateFile(this.stateFile(env, udid)).perf;
		if (typeof perf !== "object" || perf === null || !("sessionId" in perf)) return undefined;
		return typeof perf.sessionId === "string" ? perf.sessionId : undefined;
	}

	/**
	 * Point the device's `state.json` at a perf session (or clear the pointer with `undefined`), keeping every other key
	 * as it is, under the store's transaction like every other `state.json` writer.
	 */
	setPerfPointer(env: Pick<PerfEnv, "env" | "now" | "store">, udid: string, sessionId: string | undefined): void {
		env.store().transaction(() => {
			const path = this.stateFile(env, udid);
			const state = this.readStateFile(path);
			const { perf: _previous, ...rest } = state;
			const next: StateFile = {
				generation: 0,
				...rest,
				...(sessionId === undefined ? {} : { perf: { sessionId } }),
				updatedAt: env.now(),
			};
			mkdirSync(uiPaths.uiDir(storeLocator.wardenHome(env.env), udid), { recursive: true });
			this.writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
		});
	}

	/** The Metro URL `warden ui open --metro` remembered for the device, if any. */
	readMetroUrl(env: Pick<PerfEnv, "env">, udid: string): string | undefined {
		const url = this.readStateFile(this.stateFile(env, udid)).metroUrl;
		return typeof url === "string" ? url : undefined;
	}
}

export const perfDeviceState = new PerfDeviceState();
