import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDeviceDevtools, type DeviceDevtools } from "./device-devtools";
import type { Driver, Element, Orientation, Point, Snapshot } from "./driver/driver.types";
import { type SettleOutcome, settleByHash, snapshotHash } from "./driver/settle";
import { settled, toE2eError, unwrap } from "./driver/unwrap";
import type { E2eEnv } from "./env";
import { E2eError } from "./errors";
import { type Clock, type FixtureSession, systemClock } from "./fixture-session";
import { screenshotPath } from "./runner/artifacts";
import { renderHeader, renderSnapshot } from "./screen/render";

export type AlertAction = "accept" | "dismiss" | { button: string };

export type OpenLinkOptions = {
	/** answer iOS's "Open in …?" sheet with "Open". Default true. */
	accept?: boolean;
};

export type SnapshotTextOptions = { interactiveOnly?: boolean };

export type SettleOptions = {
	/** how long the UI must stay unchanged. Default 250 ms. */
	quietMs?: number;
	/** give up after this long. Default 3000 ms. */
	timeout?: number;
};

export type Device = {
	/**
	 * Answers the system alert / sheet on top. `accept` presses the first present of OK, Allow, Open,
	 * Continue, Yes, Done, Allow While Using App, Allow Once (else the last button); `dismiss` the first
	 * of Cancel, Don't Allow, Not Now, Dismiss, No, Close (else the first button); `{button}` the button
	 * with that name (`ACTION_FAILED` when absent). Resolves false when no alert is showing.
	 */
	alert(action: AlertAction): Promise<boolean>;
	/** Opens a URL from outside the app; on iOS accepts the "Open in …?" sheet when it shows within 3 s. */
	openLink(url: string, options?: OpenLinkOptions): Promise<void>;
	home(): Promise<void>;
	/** Android back key; `INVALID_ARGUMENT` on iOS (there is none). */
	back(): Promise<void>;
	orientation(set?: Orientation): Promise<Orientation>;
	appearance(set?: "light" | "dark"): Promise<"light" | "dark">;
	clipboard(): Promise<string>;
	setClipboard(text: string): Promise<void>;
	/**
	 * Dismisses the soft keyboard when the snapshot shows one, else does nothing. iOS presses Enter
	 * (which may submit the focused field); Android presses back.
	 */
	hideKeyboard(): Promise<void>;
	/** Saves `<attemptDir>/screenshots/NNN-<name>.png` and returns the path. */
	screenshot(name: string): Promise<string>;
	/** The accessibility tree as text (`warden ui snapshot` format). */
	snapshot(options?: SnapshotTextOptions): Promise<string>;
	/** Waits for a quiet UI: the driver's own settle, else snapshot-hash polling. */
	settle(options?: SettleOptions): Promise<SettleOutcome>;
	/**
	 * The app's JS runtime over Metro (evaluate, React tree, console, network, reload); `undefined` without
	 * `WARDEN_METRO_URL` (a release build). The first access starts attaching, so console capture begins there.
	 */
	readonly devtools: DeviceDevtools | undefined;
};

export type DeviceDeps = {
	session: FixtureSession;
	driver: Driver;
	env: E2eEnv;
	clock?: Clock;
};

const ACCEPT_BUTTONS = ["OK", "Allow", "Open", "Continue", "Yes", "Done", "Allow While Using App", "Allow Once"];
const DISMISS_BUTTONS = ["Cancel", "Don't Allow", "Not Now", "Dismiss", "No", "Close"];

const OPEN_LINK_WAIT_MS = 3000;
const OPEN_LINK_POLL_MS = 100;
const DEFAULT_SETTLE_QUIET_MS = 250;
const DEFAULT_SETTLE_TIMEOUT_MS = 3000;

function normalise(text: string): string {
	return text.replace(/[‘’]/g, "'").trim().toLowerCase();
}

function nameOf(button: Element): string | undefined {
	return button.label ?? button.text ?? button.value;
}

function findButton(buttons: readonly Element[], wanted: string): Element | undefined {
	const target = normalise(wanted);
	return buttons.find((button) => {
		const name = nameOf(button);
		return name !== undefined && normalise(name) === target;
	});
}

function firstOf(buttons: readonly Element[], names: readonly string[]): Element | undefined {
	for (const name of names) {
		const found = findButton(buttons, name);
		if (found !== undefined) return found;
	}
	return undefined;
}

function centre(element: Element): Point {
	const { x, y, width, height } = element.frame;
	return element.tapPoint ?? { x: x + width / 2, y: y + height / 2 };
}

function nextShotNumber(dir: string, issued: ReadonlyMap<string, number>): number {
	let highest = issued.get(dir) ?? 0;
	try {
		for (const file of readdirSync(join(dir, "screenshots"))) {
			const n = /^(\d{3})-/.exec(file)?.[1];
			if (n !== undefined) highest = Math.max(highest, Number(n));
		}
	} catch {
		// no screenshots directory yet
	}
	return highest + 1;
}

export function createDevice({ session, driver, env, clock = systemClock }: DeviceDeps): Device {
	const issued = new Map<string, number>();
	// the signal is read per call: the runner swaps it for every attempt
	const signal = (): AbortSignal | undefined => session.signal;

	const pressAlertButton = async (button: Element, action: string): Promise<void> => {
		await unwrap(() => driver.tap(centre(button)), action, signal());
	};

	const readSnapshot = (opts?: { interactiveOnly?: boolean }): Promise<Snapshot> =>
		unwrap(() => driver.snapshot(opts), "snapshot", signal());

	const { devtools: attach, peekDevtools } = session;
	let devtools: DeviceDevtools | undefined;
	const lazyDevtools = (): DeviceDevtools | undefined => {
		if (env.metroUrl === undefined || attach === undefined || peekDevtools === undefined) return undefined;
		if (devtools === undefined) {
			devtools = createDeviceDevtools({
				devtools: () => attach.call(session),
				peekDevtools: () => peekDevtools.call(session),
			});
			void attach.call(session);
		}
		return devtools;
	};

	const device: Device = {
		get devtools() {
			return lazyDevtools();
		},

		async alert(action) {
			const info = await unwrap(() => driver.alert(), "read alert", signal());
			if (info === null || info.buttons.length === 0) return false;
			const { buttons } = info;
			let target: Element | undefined;
			if (action === "accept") target = firstOf(buttons, ACCEPT_BUTTONS) ?? buttons[buttons.length - 1];
			else if (action === "dismiss") target = firstOf(buttons, DISMISS_BUTTONS) ?? buttons[0];
			else {
				target = findButton(buttons, action.button);
				if (target === undefined) {
					const names = buttons.map((b) => nameOf(b) ?? "?").join(", ");
					throw new E2eError("ACTION_FAILED", `alert has no "${action.button}" button (buttons: ${names})`);
				}
			}
			if (target === undefined) return false;
			await pressAlertButton(target, "press alert button");
			return true;
		},

		async openLink(url, options = {}) {
			await unwrap(() => driver.app.openUrl(url), `open ${url}`, signal());
			if (options.accept === false || driver.platform !== "ios" || !driver.capabilities.alerts) return;
			const deadline = clock.now() + OPEN_LINK_WAIT_MS;
			for (;;) {
				const info = await unwrap(() => driver.alert(), "read alert", signal());
				const open = info === null ? undefined : findButton(info.buttons, "Open");
				if (open !== undefined) {
					await pressAlertButton(open, "accept open-in sheet");
					return;
				}
				if (clock.now() >= deadline) return;
				await clock.sleep(OPEN_LINK_POLL_MS);
			}
		},

		async home() {
			await unwrap(() => driver.pressButton("home"), "press home", signal());
		},

		async back() {
			if (driver.platform === "ios") {
				throw new E2eError("INVALID_ARGUMENT", "device.back() is Android only: iOS has no back key");
			}
			await unwrap(() => driver.pressButton("back"), "press back", signal());
		},

		orientation(set) {
			return unwrap(() => driver.orientation(set), "orientation", signal());
		},

		appearance(set) {
			return unwrap(() => driver.appearance(set), "appearance", signal());
		},

		clipboard() {
			return unwrap(() => driver.clipboard(), "read clipboard", signal());
		},

		async setClipboard(text) {
			await unwrap(() => driver.clipboard(text), "set clipboard", signal());
		},

		async hideKeyboard() {
			const snapshot = await readSnapshot();
			if (!snapshot.flat.some((element) => element.role === "keyboard")) return;
			if (driver.platform === "ios") await unwrap(() => driver.key("Enter"), "hide keyboard", signal());
			else await unwrap(() => driver.pressButton("back"), "hide keyboard", signal());
		},

		async screenshot(name) {
			const dir = session.attemptDir ?? join(session.out, "adhoc");
			const n = nextShotNumber(dir, issued);
			issued.set(dir, n);
			const path = screenshotPath(dir, n, name);
			mkdirSync(dirname(path), { recursive: true });
			const shot = await unwrap(() => driver.screenshot({ path }), "screenshot", signal());
			if (shot.path === undefined && shot.png !== undefined) writeFileSync(path, shot.png);
			session.trace?.write({ type: "screenshot", ts: clock.now(), kind: "device", label: name, path });
			return path;
		},

		async snapshot(options = {}) {
			const interactiveOnly = options.interactiveOnly ?? false;
			const snapshot = await readSnapshot({ interactiveOnly });
			const rendered = renderSnapshot(snapshot, { interactiveOnly, refs: new Map() });
			return [renderHeader({ snapshot, rendered, interactiveOnly }), ...rendered.lines].join("\n");
		},

		async settle(options = {}) {
			const quietMs = options.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
			const timeoutMs = options.timeout ?? DEFAULT_SETTLE_TIMEOUT_MS;
			const native = await settled(() => driver.settle({ quietMs, timeoutMs }), "settle", signal());
			if (native.success) return native.data;
			if (native.error.code !== "E_UNSUPPORTED") throw toE2eError(native.error, "settle");
			return settleByHash(async () => snapshotHash(await readSnapshot()), {
				quietMs,
				timeoutMs,
				now: clock.now,
				sleep: clock.sleep,
			});
		},
	};
	return device;
}
