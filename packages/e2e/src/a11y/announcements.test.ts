import { describe, expect, test } from "bun:test";
import type { A11yEventsRead } from "../driver/a11y-events";
import { fakeDriver } from "../driver/driver.testing";
import type { Driver } from "../driver/driver.types";
import type { A11yEvent } from "./a11y.types";
import { waitForAnnouncement } from "./announcements";

const ev = (kind: A11yEvent["kind"], text: string | undefined, at = 0): A11yEvent => ({
	kind,
	...(text === undefined ? {} : { text }),
	at,
	source: "uiad",
});

/** A driver whose a11yEvents answers scripted pages, one per poll, then empty pages at the last cursor. */
function scripted(pages: readonly A11yEventsRead[]) {
	const sinces: (number | undefined)[] = [];
	const driver = Object.assign(fakeDriver({ screens: [] }), {
		async a11yEvents(since?: number) {
			sinces.push(since);
			const page = pages[sinces.length - 1] ?? { events: [], cursor: pages.at(-1)?.cursor ?? 0 };
			return { success: true as const, data: page };
		},
	});
	return { driver, sinces };
}

function clock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		elapsed: () => t,
	};
}

describe("waitForAnnouncement", () => {
	test("polls until a matching announcement arrives and hands back the cursor", async () => {
		const { driver, sinces } = scripted([
			{ events: [], cursor: 0 },
			{ events: [ev("screen-changed", undefined), ev("announcement", "Loading")], cursor: 2 },
			{ events: [ev("live-region", "Saved 3 items")], cursor: 3 },
		]);
		const c = clock();
		const out = await waitForAnnouncement(driver, /saved \d/i, { ...c, pollMs: 100, timeoutMs: 1000 });
		expect(out).toMatchObject({ success: true, data: { cursor: 3, event: { text: "Saved 3 items" } } });
		expect(sinces).toEqual([undefined, 0, 2]);
		expect(c.elapsed()).toBe(200);
	});

	test("a string matches by substring and respects since", async () => {
		const { driver, sinces } = scripted([{ events: [ev("announcement", "Done!")], cursor: 9 }]);
		const out = await waitForAnnouncement(driver, "Done", { ...clock(), since: 8 });
		expect(out.success).toBe(true);
		expect(sinces).toEqual([8]);
	});

	test("screen and layout changes never match, only announcements and live regions", async () => {
		const { driver } = scripted([{ events: [ev("screen-changed", "Done")], cursor: 1 }]);
		const out = await waitForAnnouncement(driver, "Done", { ...clock(), timeoutMs: 300, pollMs: 100 });
		expect(out).toMatchObject({ success: false, error: { code: "E_TIMEOUT" } });
	});

	test("times out on the injected clock and names what it saw", async () => {
		const { driver } = scripted([{ events: [ev("announcement", "Other")], cursor: 1 }]);
		const c = clock();
		const out = await waitForAnnouncement(driver, "Never", { ...c, timeoutMs: 500, pollMs: 100 });
		expect(out).toMatchObject({ success: false, error: { code: "E_TIMEOUT", detail: { seen: ["Other"], cursor: 1 } } });
		expect(c.elapsed()).toBe(500);
	});

	test("a driver without the capability is E_UNSUPPORTED; a read error is returned as is", async () => {
		const plain: Driver = fakeDriver({ screens: [] });
		expect(await waitForAnnouncement(plain, "x")).toMatchObject({ success: false, error: { code: "E_UNSUPPORTED" } });
		const failing = Object.assign(fakeDriver({ screens: [] }), {
			a11yEvents: async () => ({
				success: false as const,
				error: { code: "E_UNSUPPORTED" as const, message: "no dylib", retryable: false },
			}),
		});
		expect(await waitForAnnouncement(failing, "x", clock())).toMatchObject({
			success: false,
			error: { message: "no dylib" },
		});
	});
});
