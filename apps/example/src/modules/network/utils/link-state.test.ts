import { describe, expect, test } from "bun:test";
import { classify, type LinkReading, linkText } from "./link-state";
import type { Sample } from "./samples";

const UP: LinkReading = { isConnected: true, isInternetReachable: true, type: "wifi" };
const DOWN: LinkReading = { isConnected: false, isInternetReachable: false, type: "none" };
const ok = (id: number, ms: number): Sample => ({ id, at: id * 1500, ok: true, ms, status: 200 });
const bad = (id: number): Sample => ({ id, at: id * 1500, ok: false, ms: 12, reason: "reset" });
const run = (samples: Sample[], link: LinkReading = UP, extra: { paused?: boolean; linkChanges?: number } = {}) =>
	classify({ samples, link, paused: extra.paused ?? false, linkChangesInWindow: extra.linkChanges ?? 0 });

describe("classify", () => {
	test("no samples yet is Starting", () => {
		expect(run([]).kind).toBe("starting");
	});

	test("fast successes are Online with the median in the line", () => {
		const state = run([ok(1, 40), ok(2, 48), ok(3, 60)]);
		expect(state).toMatchObject({ kind: "online", title: "Online", quality: 3, tone: "open" });
		expect(state.body).toBe("Median 48 ms over the last 3 requests.");
	});

	test("the median is taken over the last 3 landed requests only", () => {
		const state = run([ok(1, 5000), ok(2, 40), ok(3, 40), ok(4, 40), ok(5, 40), ok(6, 40), ok(7, 40)]);
		expect(state.kind).toBe("online");
		expect(state.body).toBe("Median 40 ms over the last 3 requests.");
	});

	test("a median above 300 ms with every request landing is a Slow link", () => {
		const state = run([ok(1, 1800), ok(2, 1900), ok(3, 2100)]);
		expect(state).toMatchObject({ kind: "slow", title: "Slow link", quality: 2, tone: "scan" });
		expect(state.body).toBe("Median 1.9 s, every request still lands.");
	});

	test("successes mixed with failures are Unstable", () => {
		const state = run([ok(1, 40), bad(2), ok(3, 40), bad(4), ok(5, 40), bad(6), ok(7, 40), bad(8)]);
		expect(state).toMatchObject({ kind: "unstable", title: "Unstable", quality: 1, tone: "warn" });
		expect(state.body).toBe("3 of the last 6 requests failed.");
	});

	test("two link changes in the window are Unstable even when requests land", () => {
		expect(run([ok(1, 40), ok(2, 40)], UP, { linkChanges: 2 }).kind).toBe("unstable");
	});

	test("once the latest two land again, old failures stop counting", () => {
		expect(run([bad(1), bad(2), ok(3, 40), ok(4, 44)]).kind).toBe("online");
	});

	test("repeated failures on a reachable link are Requests failing", () => {
		const state = run([ok(1, 40), bad(2), bad(3)]);
		expect(state).toMatchObject({ kind: "failing", title: "Requests failing", quality: 1, tone: "warn" });
		expect(state.body).toBe("Connection reset by the network.");
	});

	test("a link NetInfo reports down is Offline, with or without samples", () => {
		expect(run([bad(1)], DOWN).kind).toBe("offline");
		const state = run([], DOWN);
		expect(state).toMatchObject({ kind: "offline", title: "Offline", quality: 0, tone: "off" });
		expect(state.body).toBe("No route out. Probes keep trying.");
	});

	test("repeated failures with the link no longer confirmed reachable are Offline", () => {
		const unconfirmed: LinkReading = { isConnected: true, isInternetReachable: null, type: "wifi" };
		expect(run([bad(1), bad(2), bad(3)], unconfirmed).kind).toBe("offline");
	});

	test("a request that landed beats a stale NetInfo down reading", () => {
		const stale: LinkReading = { isConnected: true, isInternetReachable: false, type: "wifi" };
		expect(run([ok(1, 40), ok(2, 40)], stale).kind).toBe("online");
	});

	test("Paused keeps the glyph on the last measured quality", () => {
		const state = run([ok(1, 40), ok(2, 48)], UP, { paused: true });
		expect(state).toMatchObject({ kind: "paused", title: "Paused", quality: 3, tone: "idle" });
	});
});

describe("linkText", () => {
	test("type and reachability in words", () => {
		expect(linkText(UP)).toBe("wifi · connected");
		expect(linkText(DOWN)).toBe("none");
		expect(linkText({ isConnected: true, isInternetReachable: false, type: "wifi" })).toBe("wifi · unreachable");
		expect(linkText({ isConnected: null, isInternetReachable: null, type: "unknown" })).toBe("unknown");
	});
});
