import { alertButtons } from "@delacour/warden-driver/alert-buttons";
import type { AlertBackend } from "@delacour/warden-driver/alerts";
import type { AlertInfo, Element } from "@delacour/warden-driver/driver.types";
import type { Locator } from "@delacour/warden-screen/locator";
import type { Clock } from "./fixture-session";

/** A loaded machine can show the sheet several seconds after `openUrl` returns. */
export const OPEN_LINK_WAIT_MS = 8000;
/** The sheet most likely shows within the first second (of the link, or after a press): look often, then back off. */
const FAST_POLL_MS = 100;
const FAST_WINDOW_MS = 1000;
const SLOW_POLL_MS = 250;
/** No sheet for this long, read by both readers, with the app in front = the link opened without one. */
const QUIET_MS = 1200;
const MAX_PRESSES = 3;
/**
 * A sheet ignores touches while it animates in, and the first read can see it that early (observed on a fresh
 * simulator: three presses 120 ms apart, from the first read that saw the sheet, were all lost). Press only once it has
 * been up this long, and leave this long between presses and before giving up on the last one.
 */
const SHEET_SETTLE_MS = 500;
const PRESS_GAP_MS = 600;

export type LinkDeps = {
	clock: Clock;
	/** `readAlert`: with a backend, one reader; without, both */
	readAlert(backend?: AlertBackend, modalLooks?: number): Promise<AlertInfo | null>;
	press(button: Element): Promise<void>;
	/** is the app under test in front; undefined = cannot tell */
	appInFront(): Promise<boolean | undefined>;
	isVisible(locator: Locator): Promise<boolean>;
	/** `deviceLinks.sheetlessFor(session)` */
	sheetless: Set<string>;
};

export type LinkPlan = {
	key: string;
	/** iOS, `accept` not false: there may be an "Open in …?" sheet to answer */
	answersSheet: boolean;
	until?: Locator;
	waitMs: number;
};

type Watch = {
	/** still reading alerts */
	looking: boolean;
	presses: number;
	/** when the sheet now up was first seen */
	sheetSeenAt: number | undefined;
	lastPressAt: number | undefined;
	/** when a sheet was last seen (the start, until one is): the quiet window counts from here */
	lastSheetAt: number;
};

type Look = {
	sheetUp: boolean;
	/** no sheet is up, per a read of both readers (or none was needed): the link may be handled */
	confirmed: boolean;
	/** pressed Open as often as allowed and nothing else is awaited */
	finished: boolean;
};

const NOT_LOOKING: Look = { sheetUp: false, confirmed: false, finished: false };

/**
 * Waits for one link `openUrl` just opened to be handled (see `Device.openLink`): the sheet answered, or the app in front
 * with no sheet for 1.2 s, or `until` visible, or `waitMs` over. Reads alerts every 100 ms for the first second, every
 * 250 ms after. While another app (SpringBoard, Safari) is in front no sheet-free verdict is reached, so it waits on.
 */
class LinkWaiter {
	private readonly started: number;
	/** a link that already opened without a sheet is not read for alerts, but still waits to be handed over to the app */
	private readonly remembered: boolean;
	private readonly watch: Watch;

	constructor(
		private readonly deps: LinkDeps,
		private readonly plan: LinkPlan
	) {
		this.started = deps.clock.now();
		this.remembered = plan.answersSheet && deps.sheetless.has(plan.key);
		this.watch = {
			looking: plan.answersSheet,
			presses: 0,
			sheetSeenAt: undefined,
			lastPressAt: undefined,
			lastSheetAt: this.started,
		};
	}

	async run(): Promise<void> {
		const { clock, sheetless } = this.deps;
		const { plan, watch } = this;
		const deadline = this.started + plan.waitMs;
		for (;;) {
			const look = await this.lookForSheet();
			if (look.finished || (await this.reachedTarget(look)) || clock.now() >= deadline) return;
			if (await this.handedOver(look)) {
				sheetless.add(plan.key);
				if (plan.until === undefined) return;
				watch.looking = false;
			}
			await clock.sleep(this.nextPollMs(clock.now() - watch.lastSheetAt));
		}
	}

	/**
	 * One look for the "Open in …?" sheet: a read of the cheap host reader inside the quiet window, of both readers after
	 * it (so the first read after the window doubles as the confirmation that no sheet is up), none while a remembered link
	 * is inside its window.
	 */
	private async lookForSheet(): Promise<Look> {
		const { deps, plan, watch, remembered } = this;
		const started = this.started;
		const { clock } = deps;
		if (!watch.looking) return NOT_LOOKING;
		if (remembered && clock.now() - started < QUIET_MS) return { sheetUp: false, confirmed: true, finished: false };
		const cheap = clock.now() - watch.lastSheetAt < QUIET_MS;
		const info = await deps.readAlert(cheap ? "ax" : undefined, 0);
		const open = info === null ? undefined : alertButtons.findButton(info.buttons, "Open");
		if (open === undefined) {
			// answered: nothing left to press once the sheet is gone
			if (watch.presses > 0) watch.looking = false;
			watch.sheetSeenAt = undefined;
			return { sheetUp: false, confirmed: !cheap, finished: false };
		}
		const now = clock.now();
		watch.lastSheetAt = now;
		watch.sheetSeenAt ??= now;
		const since = (at: number | undefined) => (at === undefined ? Number.POSITIVE_INFINITY : now - at);
		const settled = since(watch.sheetSeenAt) >= SHEET_SETTLE_MS && since(watch.lastPressAt) >= PRESS_GAP_MS;
		if (!settled) return { sheetUp: true, confirmed: false, finished: false };
		if (watch.presses >= MAX_PRESSES) return { sheetUp: true, confirmed: false, finished: plan.until === undefined };
		// a press can still be lost, so look again after each one
		await deps.press(open);
		watch.presses += 1;
		watch.lastPressAt = clock.now();
		return { sheetUp: true, confirmed: false, finished: false };
	}

	/** The app is in front and no sheet showed for the quiet window (none at all for a remembered link). */
	private async handedOver(look: Look): Promise<boolean> {
		const { deps, watch, remembered } = this;
		if (!watch.looking || !look.confirmed) return false;
		if (deps.clock.now() - watch.lastSheetAt < (remembered ? 0 : QUIET_MS)) return false;
		return (await deps.appInFront()) === true;
	}

	/** The caller's own finish line: `until` visible with no sheet up, or (without `until`) the sheet answered. */
	private async reachedTarget(look: Look): Promise<boolean> {
		const { plan, watch } = this;
		if (plan.until === undefined) return !watch.looking;
		return !look.sheetUp && (await this.deps.isVisible(plan.until));
	}

	/**
	 * How long to sleep before the next look, `sinceSheet` ms after the sheet was last seen (or the link opened). The first
	 * look after the quiet window is the one that ends the wait, so the poll that crosses the window's end is cut short to
	 * land on it instead of overshooting by up to a slow poll.
	 */
	private nextPollMs(sinceSheet: number): number {
		const poll = sinceSheet < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
		const untilQuiet = QUIET_MS - sinceSheet;
		return untilQuiet > 0 ? Math.min(poll, untilQuiet) : poll;
	}
}

/** What the device remembers about links, per session, and the link wait itself. */
export class DeviceLinks {
	/**
	 * What `openLink` remembers per session: the links (see {@link DeviceLinks.linkKey}) that opened without an "Open in …?" sheet.
	 * Every test builds its own `device`, the session is what lives for the whole run.
	 */
	private readonly sheetlessLinks = new WeakMap<object, Set<string>>();

	/** Per session: how many `openLink` waits are running (the device owns the "Open in …?" sheet meanwhile). */
	private readonly linksInFlight = new WeakMap<object, number>();

	sheetlessFor(session: object): Set<string> {
		const known = this.sheetlessLinks.get(session) ?? new Set<string>();
		this.sheetlessLinks.set(session, known);
		return known;
	}

	/**
	 * Whether `openLink` is waiting on a link in `session`. Reads that answer system alerts (`test.use({ systemAlerts })`)
	 * leave alerts alone meanwhile: a read that cancelled (or pressed) the sheet first would lose the link, or hide the
	 * sheet from `openLink`, which then remembers the scheme as having none.
	 */
	linkInFlight(session: object): boolean {
		return (this.linksInFlight.get(session) ?? 0) > 0;
	}

	/** Runs `fn` with a link in flight in `session` (see {@link DeviceLinks.linkInFlight}). */
	async whileLinkInFlight<T>(session: object, fn: () => Promise<T>): Promise<T> {
		this.linksInFlight.set(session, (this.linksInFlight.get(session) ?? 0) + 1);
		try {
			return await fn();
		} finally {
			this.linksInFlight.set(session, (this.linksInFlight.get(session) ?? 1) - 1);
		}
	}

	/** iOS's "Open in “App”?" sheet, which only a link the test opened raises. */
	isOpenInSheet(info: Pick<AlertInfo, "title">): boolean {
		return info.title !== undefined && /^open in\b/i.test(info.title.trim());
	}

	/** `myapp` for `myapp://x/y`; `https://example.com` for web links, which are handled per host. */
	linkKey(url: string): string {
		const trimmed = url.trim();
		const web = /^(https?):\/\/([^/?#]+)/i.exec(trimmed);
		if (web !== null) return `${web[1]?.toLowerCase()}://${web[2]?.toLowerCase()}`;
		return /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase() ?? "";
	}

	waitForLink(deps: LinkDeps, plan: LinkPlan): Promise<void> {
		return new LinkWaiter(deps, plan).run();
	}
}

export const deviceLinks = new DeviceLinks();
