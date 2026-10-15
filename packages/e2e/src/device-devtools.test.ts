import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { createDevice } from "./device";
import { createDeviceDevtools, type DevtoolsSource } from "./device-devtools";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErr } from "./devtools/devtools.types";
import { stubFacet } from "./devtools/facet.testing";
import { fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { E2eEnv } from "./env";
import type { E2eError } from "./errors";
import type { FixtureSession } from "./fixture-session";

function source(result: () => DevtoolsResult<DevtoolsFacet>) {
	let opens = 0;
	let facet: DevtoolsFacet | undefined;
	const src: DevtoolsSource = {
		async devtools() {
			opens += 1;
			const r = result();
			if (r.success) facet = r.data;
			return r;
		},
		peekDevtools: () => facet,
	};
	return { src, opens: () => opens };
}

describe("createDeviceDevtools", () => {
	test("nothing is opened until a call needs the app", async () => {
		const stub = stubFacet();
		const { src, opens } = source(() => ok(stub.facet));
		const devtools = createDeviceDevtools(src);
		expect(opens()).toBe(0);
		await devtools.evaluate("1 + 1");
		expect(opens()).toBe(1);
		expect(stub.evaluated).toEqual(["1 + 1"]);
	});

	test("evaluate, reloadJs and tree pass the facet's answer through", async () => {
		const stub = stubFacet();
		stub.tree = { components: [{ id: 0, name: "View", parent: null }], truncated: false };
		const devtools = createDeviceDevtools(source(() => ok(stub.facet)).src);
		expect(await devtools.reloadJs()).toEqual(ok({ method: "cdp" }));
		const tree = await devtools.tree({ all: true });
		expect(tree.success && tree.data.components).toHaveLength(1);
		expect(stub.treeCalls).toEqual([{ all: true }]);
	});

	test("console and network are async: they wait for the attach", async () => {
		const stub = stubFacet();
		stub.consoleLines = [{ ts: 1, level: "log", kind: "console", text: "hi" }];
		const devtools = createDeviceDevtools(source(() => ok(stub.facet)).src);
		expect((await devtools.console.lines()).map((l) => l.text)).toEqual(["hi"]);
		await devtools.console.mark("here");
		expect((await devtools.console.lines()).map((l) => l.text)).toEqual(["hi", "here"]);
		await devtools.console.clear();
		expect(await devtools.console.lines()).toEqual([]);
		expect(await devtools.network.entries()).toEqual([]);
	});

	test("an attach that fails fails the call with the reason, not a throw", async () => {
		const devtools = createDeviceDevtools(source(() => devtoolsErr("devtools_unavailable", "Metro is down")).src);
		const evaluated = await devtools.evaluate("1");
		expect(!evaluated.success && evaluated.error).toMatchObject({
			code: "devtools_unavailable",
			message: "Metro is down",
		});
		const tree = await devtools.tree();
		expect(!tree.success && tree.error.code).toBe("devtools_unavailable");
	});

	test("reads of console/network throw SESSION when the app cannot be reached", async () => {
		const devtools = createDeviceDevtools(source(() => devtoolsErr("devtools_unavailable", "Metro is down")).src);
		const error = await devtools.console.lines().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("SESSION");
		expect((error as E2eError).message).toContain("Metro is down");
	});

	test("connect() hands out the whole facet", async () => {
		const stub = stubFacet();
		const devtools = createDeviceDevtools(source(() => ok(stub.facet)).src);
		expect(await devtools.connect()).toBe(stub.facet);
	});
});

describe("device.devtools", () => {
	const env = (metroUrl?: string): E2eEnv => ({
		udid: "U",
		platform: "ios",
		bundleId: "com.example.app",
		launchArgs: [],
		out: "/tmp/out",
		timeoutMs: 1000,
		actionTimeoutMs: 1000,
		assertionTimeoutMs: 1000,
		headless: false,
		logTimestamps: false,
		...(metroUrl === undefined ? {} : { metroUrl }),
	});
	const driver = () => fakeDriver({ screens: [snapshotOf([])] });

	test("undefined without a Metro URL (a release build)", () => {
		const { src } = source(() => ok(stubFacet().facet));
		const session: FixtureSession = { out: "/tmp/out", ...src };
		expect(createDevice({ session, driver: driver(), env: env() }).devtools).toBeUndefined();
	});

	test("undefined when the session cannot attach devtools at all", () => {
		const session: FixtureSession = { out: "/tmp/out" };
		expect(createDevice({ session, driver: driver(), env: env("http://127.0.0.1:8081") }).devtools).toBeUndefined();
	});

	test("first access starts the attach (so console capture begins) and the object is stable", async () => {
		const stub = stubFacet();
		const { src, opens } = source(() => ok(stub.facet));
		const session: FixtureSession = { out: "/tmp/out", ...src };
		const device = createDevice({ session, driver: driver(), env: env("http://127.0.0.1:8081") });
		expect(opens()).toBe(0);
		const first = device.devtools;
		expect(opens()).toBe(1);
		expect(device.devtools).toBe(first);
		expect(opens()).toBe(1);
	});
});
