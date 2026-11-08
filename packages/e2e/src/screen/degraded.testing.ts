import { ok } from "@delacour/warden-types/result";
import type { ReactTree, TreeComponent } from "../devtools/devtools.types";
import { type ElementSpec, el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import { type TestHost, testHost } from "./screen.testing";

/** What `ax` shows after `axbridge` stalled: the error text's label, no testID. */
export function lossySnapshot(specs: ElementSpec[] = [el("text", { label: "Too short" })]): Snapshot {
	return { ...snapshotOf(specs, { backend: "ax" }), fellBackFrom: "axbridge" };
}

/** A read that came back as one childless root with no area (an app the reader could not see into). */
export function emptyRootSnapshot(): Snapshot {
	return snapshotOf([el("application", { frame: { x: 0, y: 0, width: 0, height: 0 } })]);
}

export const ERROR_COMPONENT: TreeComponent = {
	id: 1,
	name: "Text",
	testID: "error",
	parent: null,
	rect: { x: 10, y: 20, width: 100, height: 40 },
};

/**
 * A device whose every read is `screen` (a degraded one by default) and whose `axbridge` re-read stalls. `react` gives
 * the host devtools whose React tree holds those components (absent = no devtools).
 */
export type DegradedOptions = { screen?: () => Snapshot; react?: () => TreeComponent[]; actionTimeoutMs?: number };

export function degradedHost(options: DegradedOptions = {}): {
	driver: FakeDriver;
	host: TestHost;
	reactReads: () => number;
} {
	const screen = options.screen ?? (() => lossySnapshot());
	const driver = fakeDriver({
		screens: screen,
		onCall: (call) =>
			call.method === "snapshot" && call.opts?.backend === "axbridge"
				? failWith("E_TIMEOUT", "the axbridge guest did not answer within 4000 ms")
				: undefined,
	});
	const host = testHost(driver, {
		assertionTimeoutMs: 2000,
		...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: options.actionTimeoutMs }),
	});
	let reads = 0;
	const react = options.react;
	if (react !== undefined) {
		host.devtools = () => ({
			tree: async () => {
				reads += 1;
				const tree: ReactTree = { components: react(), truncated: false };
				return ok(tree);
			},
		});
	}
	return { driver, host, reactReads: () => reads };
}

/**
 * The sign-in field error as read on an iOS 26 simulator (example app, `not-an-email` submitted): `axbridge` has the
 * StaticText with `identifier: "sign-in-email-error"`, host `ax` the same node, same frame, `identifier: null` (also
 * when every AX key is requested), so only the rect ties it to its React component.
 */
export const EMAIL_ERROR_FRAME = { x: 20, y: 258, width: 362, height: 20 };
export const EMAIL_ERROR_TEXT = "Enter a valid email address.";

/** That `ax` read: the field above and the error text without its testID. */
export function measuredLossySnapshot(): Snapshot {
	return lossySnapshot([
		el("other", {
			frame: { x: 0, y: 0, width: 390, height: 844 },
			children: [
				el("textfield", {
					id: "sign-in-email",
					value: "not-an-email",
					frame: { x: 21, y: 209, width: 360, height: 42 },
				}),
				el("text", { label: EMAIL_ERROR_TEXT, frame: EMAIL_ERROR_FRAME }),
			],
		}),
	]);
}

/** The React component behind that text: `Field.Error testID="sign-in-email-error"`. */
export const EMAIL_ERROR_COMPONENT: TreeComponent = {
	id: 7,
	name: "Text",
	testID: "sign-in-email-error",
	text: EMAIL_ERROR_TEXT,
	parent: null,
	rect: EMAIL_ERROR_FRAME,
};

/**
 * The form alert: a `View testID="sign-in-error"` around the message. Host `ax` drops the View entirely (no node has
 * its frame), so the React tree is the only source of its text.
 */
export const FORM_ERROR_COMPONENT: TreeComponent = {
	id: 3,
	name: "View",
	testID: "sign-in-error",
	text: "This account is locked. Try another email.",
	parent: null,
	rect: { x: 20, y: 182, width: 362, height: 82 },
};
