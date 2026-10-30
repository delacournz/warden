import type { TextSize } from "@delacour/warden-core/conditions/conditions.types";
import type { Result } from "@delacour/warden-types/result";
import type {
	A11yAuditOptions,
	A11yAuditResult,
	A11yEvent,
	A11yEventSource,
	A11yIgnore,
	A11yIssue,
	Announcement,
	ScreenReaderState,
	SpokenLine,
} from "./a11y/a11y.types";
import type { A11yTarget } from "./a11y/a11y-target";
import { type AnnouncementMatch, waitForAnnouncement } from "./a11y/announcements";
import { mergeIssues, runAudit } from "./a11y/audit";
import { readingOrder } from "./a11y/order";
import { announce } from "./a11y/speech";
import { canReadA11yEvents } from "./driver/a11y-events";
import { canReadA11y } from "./driver/a11y-read";
import type { Driver, DriverError, Snapshot } from "./driver/driver.types";
import { driverError } from "./driver/errors";
import { canAuditNatively } from "./driver/native-audit";
import { canDriveScreenReader, type SpokenRead } from "./driver/screen-reader";
import { settled, toE2eError, unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { renderHeader, renderSnapshot } from "./screen/render";

/** `device.a11yAudit(opts)`: the audit's own options, plus what only a device knows. */
export type DeviceA11yAuditOptions = A11yAuditOptions & {
	/** the text size the app runs at; `text-clipped` only runs from `accessibility-medium` up */
	textSize?: TextSize;
	/** also run the platform's own audit (XCUITest on iOS, ATF on Android) when the driver can. Default true. */
	native?: boolean;
};

/** An announcement or live-region change the app made, in the order it happened. */
export type A11yAnnouncement = {
	kind: "announcement" | "live-region";
	text: string;
	/** epoch ms on the device */
	at: number;
	source: A11yEventSource;
};

export type A11yAnnouncementsOptions = {
	/** cursor from an earlier read: only what came after it */
	since?: number;
};

export type A11yAnnouncements = {
	announcements: A11yAnnouncement[];
	/** pass back as `since` to read only what is new */
	cursor: number;
	/** the Android event buffer overwrote events this caller never read */
	lost?: boolean;
};

export type ScreenReaderSpokenOptions = { since?: number };

/**
 * What a screen reader does with the screen. `order()` is warden's model of the reading order and works on both
 * platforms (every `Announcement` is `source: "simulated"`: an approximation, never what VoiceOver or TalkBack
 * say). The other calls drive a real TalkBack on an Android emulator (`device.a11y({ screenReader: true })`) and
 * throw `ACTION_FAILED` (`E_UNSUPPORTED`) anywhere else.
 */
export type DeviceScreenReader = {
	/** reading order of the current screen */
	order(): Promise<Announcement[]>;
	state(): Promise<ScreenReaderState>;
	/** moves screen-reader focus one step on; resolves what it now holds (`undefined` past the end) */
	next(): Promise<Announcement | undefined>;
	prev(): Promise<Announcement | undefined>;
	/** double-tap on the focused node */
	activate(): Promise<void>;
	/** the node holding screen-reader focus, if any */
	focused(): Promise<Announcement | undefined>;
	/** what the reader said since `since`; `cursor` goes back in as the next `since` */
	spoken(options?: ScreenReaderSpokenOptions): Promise<{ lines: SpokenLine[]; cursor: number }>;
};

export type DeviceA11y = {
	/**
	 * Audits the current screen: warden's rules over the snapshot (with the iOS injected read merged in when the app
	 * runs with it) plus the platform's own audit when the driver offers one. The suite's `a11y` config
	 * (`warden.config.ts`) supplies the defaults; options passed here win key by key.
	 */
	a11yAudit(options?: DeviceA11yAuditOptions): Promise<A11yAuditResult>;
	readonly screenReader: DeviceScreenReader;
	/** announcements and live-region changes since `since` (needs the injected library on iOS) */
	announcements(options?: A11yAnnouncementsOptions): Promise<A11yAnnouncements>;
};

export type DeviceA11yDeps = {
	driver: Driver;
	env: E2eEnv;
	/** read per call: the runner swaps it for every attempt */
	signal: () => AbortSignal | undefined;
	step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
};

const TALKBACK_HINT = "turn TalkBack on with device.a11y({ screenReader: true }) on an Android emulator";

function unsupported(action: string, why: string) {
	return toE2eError(driverError("E_UNSUPPORTED", why), action);
}

/**
 * The snapshot with the screen-reader facts a plain snapshot lacks merged in. A driver without the capability, or an
 * app launched without the injected library (`E_UNSUPPORTED`), leaves it as it is. Any other failure is returned.
 */
export async function withA11yRead(driver: Driver, snapshot: Snapshot): Promise<Result<Snapshot, DriverError>> {
	if (!canReadA11y(driver)) return { success: true, data: snapshot };
	const read = await driver.readA11y(snapshot);
	if (read.success) return read;
	if (read.error.code === "E_UNSUPPORTED") return { success: true, data: snapshot };
	return read;
}

const A11Y_EXCERPT_LINES = 40;

/** The screen as text with the `--a11y` columns: what an a11y failure attaches as `screen-at-failure.txt`. */
export function renderA11yScreen(snapshot: Snapshot, maxLines = A11Y_EXCERPT_LINES): string {
	const rendered = renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map(), a11y: true, maxLines });
	return [renderHeader({ snapshot, rendered, interactiveOnly: true }), ...rendered.lines].join("\n");
}

function ignored(issue: A11yIssue, ignore: readonly A11yIgnore[]): boolean {
	return ignore.some((g) => g.rule === issue.rule && (g.identifier === undefined || g.identifier === issue.identifier));
}

export function createDeviceA11y(deps: DeviceA11yDeps): DeviceA11y & { target: A11yTarget } {
	const { driver, env } = deps;
	const signal = (): AbortSignal | undefined => deps.signal();
	const { platform } = driver;

	/** A full snapshot with the iOS inject read merged in. */
	const readSnapshot = async (): Promise<Snapshot> => {
		const snapshot = await unwrap(() => driver.snapshot(), "snapshot", signal());
		const merged = await withA11yRead(driver, snapshot);
		if (!merged.success) throw toE2eError(merged.error, "read accessibility facts");
		return merged.data;
	};

	/** `own` plus the platform's audit findings (minus the ignored), or why that engine did not run. */
	const withNative = async (own: A11yAuditResult, ignore: readonly A11yIgnore[]): Promise<A11yAuditResult> => {
		const source = platform === "ios" ? "xcuitest" : "atf";
		if (!canAuditNatively(driver)) {
			return mergeIssues(own, [], [{ source, reason: "this driver has no native accessibility audit" }]);
		}
		const native = await driver.auditNatively({ bundleId: env.bundleId });
		return mergeIssues(
			own,
			native.issues.filter((issue) => !ignored(issue, ignore)),
			native.skipped === undefined ? [] : [native.skipped]
		);
	};

	const audit = async (options: DeviceA11yAuditOptions = {}): Promise<A11yAuditResult> => {
		const config = env.a11yAudit ?? {};
		const rules = options.rules ?? config.rules;
		const ignore = options.ignore ?? config.ignore ?? [];
		const minSeverity = options.minSeverity ?? config.minSeverity;
		const snapshot = await readSnapshot();
		const own = runAudit(snapshot, platform, {
			...(rules === undefined ? {} : { rules }),
			ignore,
			...(minSeverity === undefined ? {} : { minSeverity }),
			...(options.textSize === undefined ? {} : { textSize: options.textSize }),
		});
		if (options.native === false || (rules !== undefined && !rules.includes("native"))) return own;
		return withNative(own, ignore);
	};

	const announcements = async (options: A11yAnnouncementsOptions = {}): Promise<A11yAnnouncements> => {
		if (!canReadA11yEvents(driver)) {
			throw unsupported("device.announcements", "this driver cannot read announcements (no a11yEvents capability)");
		}
		const { since } = options;
		const read = await unwrap(() => driver.a11yEvents(since), "read announcements", signal());
		const announced = read.events.filter(
			(e): e is A11yEvent & { kind: A11yAnnouncement["kind"]; text: string } =>
				(e.kind === "announcement" || e.kind === "live-region") && e.text !== undefined
		);
		return {
			announcements: announced.map((e) => ({ kind: e.kind, text: e.text, at: e.at, source: e.source })),
			cursor: read.cursor,
			...(read.lost === true ? { lost: true } : {}),
		};
	};

	const reader = (action: string) => {
		if (!canDriveScreenReader(driver)) throw unsupported(action, TALKBACK_HINT);
		return driver;
	};
	const spoken = (el: Parameters<typeof announce>[0] | undefined): Announcement | undefined =>
		el === undefined ? undefined : announce(el, platform);

	const screenReader: DeviceScreenReader = {
		async order() {
			return readingOrder(await readSnapshot(), platform);
		},
		async state() {
			const d = reader("device.screenReader.state");
			return unwrap(() => d.screenReaderState(), "screen reader state", signal());
		},
		async next() {
			const d = reader("device.screenReader.next");
			return spoken(await unwrap(() => d.screenReaderNext(), "screen reader next", signal()));
		},
		async prev() {
			const d = reader("device.screenReader.prev");
			return spoken(await unwrap(() => d.screenReaderPrev(), "screen reader prev", signal()));
		},
		async activate() {
			const d = reader("device.screenReader.activate");
			await unwrap(() => d.screenReaderActivate(), "screen reader activate", signal());
		},
		async focused() {
			const d = reader("device.screenReader.focused");
			return spoken(await unwrap(() => d.screenReaderFocused(), "screen reader focused", signal()));
		},
		async spoken(options = {}) {
			const d = reader("device.screenReader.spoken");
			const read: SpokenRead = await unwrap(
				() => d.screenReaderSpoken(options.since),
				"screen reader spoken",
				signal()
			);
			return { lines: read.lines, cursor: read.cursor };
		},
	};

	const target: A11yTarget = {
		audit: (options) => audit(options),
		waitForAnnouncement(match, options): Promise<Result<AnnouncementMatch, DriverError>> {
			return waitForAnnouncement(driver, match, {
				timeoutMs: options.timeoutMs,
				...(options.since === undefined ? {} : { since: options.since }),
			});
		},
		async a11yScreen() {
			const taken = await settled(() => driver.snapshot(), "snapshot", signal());
			if (!taken.success) return undefined;
			const merged = await withA11yRead(driver, taken.data);
			return renderA11yScreen(merged.success ? merged.data : taken.data);
		},
		assertionTimeout: () => env.assertionTimeoutMs,
		step: (label, fn) => (deps.step === undefined ? fn() : deps.step(label, fn)),
	};

	return { a11yAudit: audit, screenReader, announcements, target };
}
