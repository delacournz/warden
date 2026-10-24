import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { createSession } from "./session";
import { pickSession, sessionByRef } from "./session-pick";
import { fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup() {
	const clock = { now: Date.UTC(2026, 9, 24, 10, 0, 0) };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	const deps = fakePerfDeps([sim]);
	const ids: string[] = [];
	for (const udid of ["U1", "U2"]) {
		const made = createSession(c, deps.session, {
			device: { udid, platform: "ios", name: sim.name },
			target: { udid, ownedByCaller: true },
			maxDurationMs: 30_000,
		});
		if (!made.success) throw new Error(made.error.message);
		ids.push(made.data.id);
		clock.now += 1_000;
	}
	return { c, deps, ids };
}

describe("sessionByRef", () => {
	test("exact id, unique prefix and latest resolve", () => {
		const { c, ids } = setup();
		expect(sessionByRef(c, ids[0] ?? "")).toMatchObject({ success: true });
		expect(sessionByRef(c, (ids[0] ?? "").slice(0, 20))).toMatchObject({ success: true, data: { id: ids[0] } });
		expect(sessionByRef(c, "latest")).toMatchObject({ success: true, data: { id: ids[1] } });
	});

	test("ambiguous prefix and unknown ref are session_not_found", () => {
		const { c } = setup();
		expect(sessionByRef(c, "2026")).toMatchObject({ success: false, error: { code: "session_not_found" } });
		expect(sessionByRef(c, "zzz")).toMatchObject({ success: false, error: { code: "session_not_found" } });
	});

	test("no sessions: latest is session_not_found", () => {
		const c = testContext([]);
		ctx = c;
		expect(sessionByRef(c, "latest")).toMatchObject({ success: false });
	});
});

describe("pickSession", () => {
	test("without a ref, the newest session overall when no device resolves", async () => {
		const { c, deps } = setup();
		const r = await pickSession(c, deps, {}, undefined);
		expect(r).toMatchObject({ success: true });
	});
});
