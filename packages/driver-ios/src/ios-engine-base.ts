import { BaseDriver } from "@delacour/warden-driver/base-driver";
import type {
	AlertInfo,
	Driver,
	DriverError,
	DriverResult,
	KeyName,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import type { AlertButtonsData, HealthData, OpData } from "@delacour/warden-driver/helper/simd-protocol";
import type { DriverClient } from "./ios-session";
import { elementNormalizer } from "./normalize";
import type { RequestOptions } from "./simd-client";

export type Params = Record<string, unknown>;

export const okVoid = { success: true as const, data: undefined };

/** Slack added to a gesture's own duration before the request times out. */
const GESTURE_MARGIN_MS = 5_000;
/** `frontmost` is one launchd lookup; a helper that has not answered in this long is busy, and the caller carries on without. */
const FRONTMOST_TIMEOUT_MS = 3_000;

/** USB HID keyboard-page usage ids for the keys `Driver.key` offers. */
export const KEY_USAGE: Readonly<Record<KeyName, number>> = {
	Enter: 0x28,
	Escape: 0x29,
	Backspace: 0x2a,
	Tab: 0x2b,
	Space: 0x2c,
	Delete: 0x4c,
	Right: 0x4f,
	Left: 0x50,
	Down: 0x51,
	Up: 0x52,
};

/** What the helper's `orientation` op may read; a flat or unknown device has no interface orientation. */
type OrientationRead = OpData<"orientation">["orientation"];

/**
 * What the simulator and the physical iPhone drivers share on top of {@link BaseDriver}: both speak the
 * `warden-simd` wire protocol to a helper (`client`), so params, void sends, the one-finger gestures, `key`,
 * `health`, the raw snapshot and the alert reader are the same code. The subclass supplies the transport
 * (`request`: the simulator replaces a crashed helper, the phone does not) and what differs on the wire.
 */
export abstract class IosEngineBase extends BaseDriver {
	readonly platform = "ios" as const;

	protected abstract readonly client: DriverClient;
	/** prefix of this driver's log lines, e.g. `[ios]` */
	protected abstract readonly logTag: string;

	protected abstract request<Op extends string>(op: Op, p?: Params, o?: RequestOptions): DriverResult<OpData<Op>>;

	/** The `detail` of a `health` reply. */
	protected abstract healthDetail(d: HealthData): Record<string, unknown>;

	/** Drops `undefined` so optional driver options are absent on the wire rather than `null`. */
	protected params(values: Record<string, unknown>): Params {
		return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
	}

	protected fail(error: DriverError) {
		return { success: false as const, error };
	}

	protected gestureTimeout(durationMs: number | undefined, base = 0): number {
		return (durationMs ?? 0) + base + GESTURE_MARGIN_MS;
	}

	protected async sendVoid(op: string, p: Params = {}, timeoutMs?: number): DriverResult<void> {
		const result = await this.request(op, p, timeoutMs === undefined ? {} : { timeoutMs });
		return result.success ? okVoid : result;
	}

	/** An error that refuses `isFrontmost` outright (the simulator needs the AX bridge), else undefined. */
	protected frontmostGuard(): DriverError | undefined {
		return undefined;
	}

	protected takeSnapshot(): DriverResult<Snapshot> {
		return this.snapshot();
	}

	protected async fetchSnapshot(o?: Parameters<Driver["snapshot"]>[0]) {
		const result = await this.request(
			"snapshot",
			this.params({ interactiveOnly: o?.interactiveOnly, backend: o?.backend })
		);
		if (!result.success) return result;
		const { fallback } = result.data;
		if (fallback) {
			this.base.log?.(`${this.logTag} snapshot fell back ${fallback.from} -> ${fallback.to}: ${fallback.reason}`);
		}
		return { success: true, data: elementNormalizer.snapshot(result.data, this.base.now()) } as const;
	}

	protected toAlertInfo(data: NonNullable<AlertButtonsData>): AlertInfo {
		const { title, message, buttons } = data;
		const info: AlertInfo = { buttons: elementNormalizer.elements(buttons, this.client.ready.screen).elements };
		if (title !== undefined) info.title = title;
		if (message !== undefined) info.message = message;
		return info;
	}

	/** A flat or unknown device has no better answer than upright. */
	protected interfaceOrientation(read: OrientationRead): Exclude<OrientationRead, "faceUp" | "faceDown" | "unknown"> {
		return read === "faceUp" || read === "faceDown" || read === "unknown" ? "portrait" : read;
	}

	protected override teardown(): Promise<void> {
		return this.client.close();
	}

	readonly health: Driver["health"] = async () => {
		const result = await this.request("health");
		if (!result.success) return result;
		const d = result.data;
		return {
			success: true,
			data: {
				platform: "ios",
				id: this.id,
				version: d.version,
				transport: d.hid.transport,
				bridge: d.ax.bridge === "degraded" ? "available" : d.ax.bridge,
				screen: d.screen,
				detail: this.healthDetail(d),
			},
		};
	};

	readonly snapshot: Driver["snapshot"] = (o) => this.fetchSnapshot(o);

	readonly tap: Driver["tap"] = (point, o) =>
		this.sendVoid("tap", this.params({ x: point.x, y: point.y, count: o?.count, durationMs: o?.durationMs }));

	readonly longPress: Driver["longPress"] = (point, o) =>
		this.sendVoid(
			"longPress",
			this.params({ x: point.x, y: point.y, durationMs: o?.durationMs }),
			this.gestureTimeout(o?.durationMs, 1_000)
		);

	readonly drag: Driver["drag"] = (from, to, o) =>
		this.sendVoid(
			"drag",
			this.params({ from, to, pressMs: o?.pressMs, durationMs: o?.durationMs, releaseMs: o?.releaseMs }),
			this.gestureTimeout((o?.pressMs ?? 0) + (o?.durationMs ?? 0) + (o?.releaseMs ?? 0), 300)
		);

	readonly key: Driver["key"] = (key, modifiers) =>
		this.sendVoid("key", this.params({ usage: KEY_USAGE[key], modifiers: modifiers && [...modifiers] }));

	readonly isFrontmost = async (bundleId: string): DriverResult<boolean> => {
		const refused = this.frontmostGuard();
		if (refused) return this.fail(refused);
		const result = await this.request("frontmost", { bundleId }, { timeoutMs: FRONTMOST_TIMEOUT_MS });
		return result.success ? { success: true, data: result.data.frontmost } : result;
	};
}
