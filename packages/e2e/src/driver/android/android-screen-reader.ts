import { TALKBACK_LOGCAT_ARGV } from "../../a11y/talkback-log";
import type { Driver, DriverResult, Element, Point } from "../driver.types";
import type { ActsOnElements, ScrollDirection } from "../element-actions";
import { driverErr } from "../errors";
import type { DrivesScreenReader } from "../screen-reader";
import type { AdbSession } from "./adb-session";
import { shellCommand } from "./android-argv";
import type { Clock } from "./android-device";
import { readSpoken } from "./android-spoken";
import type { TalkBackControl } from "./android-talkback";
import type { UiadOps } from "./uiad-ops";

/**
 * The Android driver while TalkBack is on (WDN-A11Y, A11Y-7): the `DrivesScreenReader` calls, and the element actions
 * that replace touches. With TalkBack on a tap only moves its focus and a one-finger swipe navigates, so a locator tap
 * is `ACTION_CLICK` on the node and a locator scroll is `ACTION_SCROLL_*` on its scrollable (server ops, no touch).
 * Raw coordinate taps never come through here and stay touches: with TalkBack on they move its focus, and whether that
 * also activates depends on its "single-tap to activate" setting.
 */

export type ScreenReaderDeps = {
	uiad: UiadOps | undefined;
	talkback: TalkBackControl;
	session: AdbSession;
	clock: Clock;
	/** a touch, for the focus-then-double-tap fallback */
	tap: Driver["tap"];
};

const ok = <T>(data: T): { success: true; data: T } => ({ success: true, data });

const centre = (element: Element): Point =>
	element.tapPoint ?? {
		x: element.frame.x + element.frame.width / 2,
		y: element.frame.y + element.frame.height / 2,
	};

const NEEDS_UIAD = "TalkBack mode needs the warden-uiad server";

export function createScreenReaderOps(deps: ScreenReaderDeps): DrivesScreenReader & ActsOnElements {
	const { uiad, talkback } = deps;

	/** the uiad ops when TalkBack is on, else why not */
	async function engaged(): DriverResult<UiadOps> {
		if (!(await talkback.detect())) {
			return driverErr("E_UNSUPPORTED", "TalkBack is off: turn it on with a11y({ screenReader: true }) first");
		}
		return uiad === undefined ? driverErr("E_UNSUPPORTED", NEEDS_UIAD) : ok(uiad);
	}

	async function focusStop(dir: "next" | "prev"): DriverResult<Element | undefined> {
		const server = await engaged();
		if (!server.success) return server;
		const moved = await server.data.srFocus({ dir });
		if (moved === undefined) return driverErr("E_UNSUPPORTED", NEEDS_UIAD);
		return moved.success ? ok(moved.data.element) : moved;
	}

	return {
		async screenReaderState() {
			await talkback.detect();
			return ok(talkback.state());
		},
		screenReaderNext: () => focusStop("next"),
		screenReaderPrev: () => focusStop("prev"),
		async screenReaderActivate() {
			const server = await engaged();
			if (!server.success) return server;
			return (await server.data.srActivate()) ?? driverErr("E_UNSUPPORTED", NEEDS_UIAD);
		},
		async screenReaderFocused() {
			const server = await engaged();
			if (!server.success) return server;
			return (await server.data.srFocused()) ?? driverErr("E_UNSUPPORTED", NEEDS_UIAD);
		},
		async screenReaderSpoken(since) {
			const server = await engaged();
			if (!server.success) return server;
			return readSpoken(
				{
					readLog: async () => {
						const res = await deps.session.run(shellCommand(TALKBACK_LOGCAT_ARGV));
						return res.success && res.data.exitCode === 0 ? res.data.stdout : undefined;
					},
					focusEvents: async () => (await server.data.srEvents(0)) ?? driverErr("E_UNSUPPORTED", NEEDS_UIAD),
					now: () => deps.clock.now(),
					sleep: (ms) => deps.clock.sleep(ms),
				},
				since
			);
		},

		async pressElement(element) {
			if (uiad === undefined || !(await talkback.detect())) return ok(false);
			const point = centre(element);
			const clicked = await uiad.actionClick(point);
			if (clicked?.success) return ok(true);
			if (clicked) return clicked;
			// nothing clickable in the tree there: land TalkBack's focus on it and double-tap, as a person would
			const focused = await uiad.srFocus({ point });
			if (focused !== undefined && !focused.success) return focused;
			if (focused === undefined) return ok(false);
			const tapped = await deps.tap(point, { count: 2 });
			return tapped.success ? ok(true) : tapped;
		},

		async scrollElement(direction: ScrollDirection, within) {
			if (uiad === undefined || !(await talkback.detect())) return ok(false);
			const forward = direction === "down" || direction === "right";
			const moved = await uiad.actionScroll(forward ? "forward" : "backward", within ? centre(within) : undefined);
			if (moved === undefined) return ok(false);
			// false from the node is the end of the content: handled, there was nothing to move
			return moved.success ? ok(true) : moved;
		},
	};
}
