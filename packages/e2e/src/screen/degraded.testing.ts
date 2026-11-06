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
export function degradedHost(
	options: { screen?: () => Snapshot; react?: () => TreeComponent[]; actionTimeoutMs?: number } = {}
): { driver: FakeDriver; host: TestHost; reactReads: () => number } {
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
