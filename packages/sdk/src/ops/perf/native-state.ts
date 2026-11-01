import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionCodec } from "@delacour/warden-perf/shared/session.schema";
import type { Platform } from "@delacour/warden-store/types";
import type { PerfEnv } from "./env";
import type { NativeHandle } from "./native-types";
import { perfPaths } from "./paths";

export const NATIVE_DIR = "native";
export const HANDLE_FILE = "handle.json";

/** `<native dir>/handle.json`: what `stop` (a later process) needs to find and finish the recording `start` began. */
export type HandleFile = {
	version: 1;
	status: "running" | "stopped";
	udid: string;
	platform: Platform;
	app: string;
	leaks: boolean;
	sessionId?: string;
	handle: NativeHandle;
};

/** NativeStateFiles: native state. */
export class NativeStateFiles {
	private readonly isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

	private parseHandle(raw: unknown): NativeHandle | undefined {
		if (
			!this.isRecord(raw) ||
			typeof raw.out !== "string" ||
			typeof raw.startedAtIso !== "string" ||
			typeof raw.startWallMs !== "number"
		) {
			return undefined;
		}
		const state: Record<string, string | number | boolean> = {};
		if (this.isRecord(raw.state)) {
			for (const [k, v] of Object.entries(raw.state)) {
				if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") state[k] = v;
			}
		}
		return {
			out: raw.out,
			startedAtIso: raw.startedAtIso,
			startWallMs: raw.startWallMs,
			...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
			...(typeof raw.deviceWallMs === "number" ? { deviceWallMs: raw.deviceWallMs } : {}),
			...(Object.keys(state).length > 0 ? { state } : {}),
		};
	}

	parseHandleFile(text: string): HandleFile | undefined {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (!this.isRecord(raw) || raw.version !== 1) return undefined;
		const handle = this.parseHandle(raw.handle);
		const platform = raw.platform === "ios" || raw.platform === "android" ? raw.platform : undefined;
		if (
			handle === undefined ||
			platform === undefined ||
			typeof raw.udid !== "string" ||
			typeof raw.app !== "string" ||
			(raw.status !== "running" && raw.status !== "stopped")
		) {
			return undefined;
		}
		return {
			version: 1,
			status: raw.status,
			udid: raw.udid,
			platform,
			app: raw.app,
			leaks: raw.leaks === true,
			...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
			handle,
		};
	}

	readHandleFile(nativeDir: string): HandleFile | undefined {
		try {
			return this.parseHandleFile(readFileSync(join(nativeDir, HANDLE_FILE), "utf8"));
		} catch {
			return undefined;
		}
	}

	writeHandleFile(nativeDir: string, file: HandleFile): void {
		mkdirSync(nativeDir, { recursive: true });
		writeFileSync(join(nativeDir, HANDLE_FILE), `${JSON.stringify(file, null, 2)}\n`);
	}

	/** The `native/` dir of a session. */
	readonly sessionNativeDir = (ctx: Pick<PerfEnv, "env">, sessionId: string): string =>
		join(perfPaths.sessionDir(ctx, sessionId), NATIVE_DIR);

	/** A fresh one-shot dir `$WARDEN_HOME/perf/native-<id>/native` (the name is not a session id, so session listing ignores it). */
	newOneShotDir(ctx: Pick<PerfEnv, "env" | "now">, random: () => string): string {
		return join(perfPaths.perfRoot(ctx), `native-${sessionCodec.formatSessionId(ctx.now(), random())}`, NATIVE_DIR);
	}

	/** The newest one-shot recording still running on `udid`, if any. */
	findRunningOneShot(ctx: Pick<PerfEnv, "env">, udid: string): { dir: string; file: HandleFile } | undefined {
		let names: string[];
		try {
			names = readdirSync(perfPaths.perfRoot(ctx));
		} catch {
			return undefined;
		}
		const found = names
			.filter((n) => n.startsWith("native-"))
			.sort()
			.reverse()
			.map((n) => join(perfPaths.perfRoot(ctx), n, NATIVE_DIR));
		for (const dir of found) {
			const file = this.readHandleFile(dir);
			if (file?.status === "running" && file.udid === udid) return { dir, file };
		}
		return undefined;
	}

	/** The directory a `.trace` lives in (where its `handle.json` sidecar is). */
	readonly traceDir = (trace: string): string => dirname(trace);
}

export const nativeStateFiles = new NativeStateFiles();
