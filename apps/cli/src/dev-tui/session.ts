import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { DevReady } from "../commands/dev-ui";
import type { CommandContext } from "../context";
import type { MetricsTarget } from "../perf/metrics-sampler";
import { HUD_DEFAULT_INTERVAL_MS, type Hud, type HudDeps, startHud } from "./hud";
import type { HudFps, HudSample } from "./model";
import type { TuiEvent } from "./reducer";
import { openSessionLog } from "./session-log";

export type SessionDeps = {
	ctx: CommandContext;
	now(): number;
	/** sampling interval of the HUD ticker */
	hudIntervalMs: number | undefined;
	hudSeams: Pick<HudDeps, "sampler" | "fps" | "schedule" | "fpsEvery"> | undefined;
	onSample(sample: HudSample, fps: HudFps | undefined): void;
};

export type Session = {
	/** run the HUD ticker exactly while `want` is true (`h`, `setHud` and `warden dev enable hud` flip it) */
	syncHud(want: boolean): void;
	hudOn(): boolean;
	/** write a dashboard event's text to `warden.log` */
	record(event: TuiEvent): void;
	/** raw Metro bytes to `metro.log` */
	metro(chunk: Uint8Array): void;
	/** the lease id is known: the log moves to `$WARDEN_HOME/dev/<leaseId>/` and the HUD learns its app */
	ready(info: DevReady): void;
	/** where the session log lives once `ready` gave it a directory */
	logDir(): string | undefined;
	shotsDir(): string | undefined;
	close(): void;
};

/** A dev session's on-disk log and its HUD ticker: the parts of the dashboard that outlive a frame. */
export function createSession(deps: SessionDeps): Session {
	const log = openSessionLog(undefined, { now: deps.now });
	let target: MetricsTarget | undefined;
	let ticker: Hud | undefined;
	let dir: string | undefined;

	const syncHud = (want: boolean): void => {
		if (want && ticker === undefined) {
			ticker = startHud({
				ctx: deps.ctx,
				target: () => target,
				intervalMs: deps.hudIntervalMs ?? HUD_DEFAULT_INTERVAL_MS,
				onSample: deps.onSample,
				now: deps.now,
				...deps.hudSeams,
			});
		} else if (!want && ticker !== undefined) {
			ticker.stop();
			ticker = undefined;
		}
	};

	return {
		syncHud,
		hudOn: () => ticker !== undefined,
		record(event) {
			if (event.type === "task:log") log.line(event.id, event.line);
			else if (event.type === "task:fail") log.line(event.id, `failed: ${event.error}`);
			else if (event.type === "task:ok" && event.detail) log.line(event.id, event.detail);
		},
		metro: (chunk) => log.metro(chunk),
		ready(info) {
			const lease = info.leaseIds[0];
			if (lease !== undefined) {
				dir = join(wardenHome(deps.ctx.env), "dev", lease);
				log.attach(dir);
			}
			if (info.bundleId !== undefined) target = { udid: info.deviceId, platform: info.platform, app: info.bundleId };
		},
		logDir: () => dir,
		shotsDir: () => log.shotsDir(),
		close() {
			syncHud(false);
			log.close();
		},
	};
}
