import { describe, expect, test } from "bun:test";
import { createDeviceDevtools, type DevtoolsSource } from "@delacour/warden-device/device-devtools";
import type { FixtureSession } from "@delacour/warden-device/fixture-session";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErrors } from "@delacour/warden-devtools/devtools.types";
import { facetStubs } from "@delacour/warden-devtools/testing/facet";
import type { E2eError } from "@delacour/warden-driver/e2e-error";
import { fakeDriver, snapshotOf } from "@delacour/warden-driver/testing/driver";
import { resultFactory } from "@delacour/warden-types/result";
import type { E2eEnv } from "./env";
import { deviceFor as createDevice } from "./fixtures";

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
		const stub = facetStubs.create();
		const { src, opens } = source(() => resultFactory.ok(stub.facet));
		const devtools = createDeviceDevtools(src);
		expect(opens()).toBe(0);
		await devtools.evaluate("1 + 1");
		expect(opens()).toBe(1);
		expect(stub.evaluated).toEqual(["1 + 1"]);
	});

	test("evaluate, reloadJs and tree pass the facet's answer through", async () => {
		const stub = facetStubs.create();
		stub.tree = { components: [{ id: 0, name: "View", parent: null }], truncated: false };
		const devtools = createDeviceDevtools(source(() => resultFactory.ok(stub.facet)).src);
		expect(await devtools.reloadJs()).toEqual(resultFactory.ok({ method: "expo" }));
		const tree = await devtools.tree({ all: true });
		expect(tree.success && tree.data.components).toHaveLength(1);
		expect(stub.treeCalls).toEqual([{ all: true }]);
	});

	test("console and network are async: they wait for the attach", async () => {
		const stub = facetStubs.create();
		stub.consoleLines = [{ ts: 1, level: "log", kind: "console", text: "hi" }];
		const devtools = createDeviceDevtools(source(() => resultFactory.ok(stub.facet)).src);
		expect((await devtools.console.lines()).map((l) => l.text)).toEqual(["hi"]);
		await devtools.console.mark("here");
		expect((await devtools.console.lines()).map((l) => l.text)).toEqual(["hi", "here"]);
		await devtools.console.clear();
		expect(await devtools.console.lines()).toEqual([]);
		expect(await devtools.network.entries()).toEqual([]);
	});

	test("an attach that fails fails the call with the reason, not a throw", async () => {
		const devtools = createDeviceDevtools(
			source(() => devtoolsErrors.err("devtools_unavailable", "Metro is down")).src
		);
		const evaluated = await devtools.evaluate("1");
		expect(!evaluated.success && evaluated.error).toMatchObject({
			code: "devtools_unavailable",
			message: "Metro is down",
		});
		const tree = await devtools.tree();
		expect(!tree.success && tree.error.code).toBe("devtools_unavailable");
	});

	test("reads of console/network throw SESSION when the app cannot be reached", async () => {
		const devtools = createDeviceDevtools(
			source(() => devtoolsErrors.err("devtools_unavailable", "Metro is down")).src
		);
		const error = await devtools.console.lines().catch((e: unknown) => e);
		expect((error as E2eError).code).toBe("SESSION");
		expect((error as E2eError).message).toContain("Metro is down");
	});

	test("connect() hands out the whole facet", async () => {
		const stub = facetStubs.create();
		const devtools = createDeviceDevtools(source(() => resultFactory.ok(stub.facet)).src);
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
		logTimestamps: false,
		...(metroUrl === undefined ? {} : { metroUrl }),
	});
	const driver = () => fakeDriver({ screens: [snapshotOf([])] });

	test("undefined without a Metro URL (a release build)", () => {
		const { src } = source(() => resultFactory.ok(facetStubs.create().facet));
		const session: FixtureSession = { out: "/tmp/out", ...src };
		expect(createDevice({ session, driver: driver(), env: env() }).devtools).toBeUndefined();
	});

	test("undefined when the session cannot attach devtools at all", () => {
		const session: FixtureSession = { out: "/tmp/out" };
		expect(createDevice({ session, driver: driver(), env: env("http://127.0.0.1:8081") }).devtools).toBeUndefined();
	});

	test("first access starts the attach (so console capture begins) and the object is stable", async () => {
		const stub = facetStubs.create();
		const { src, opens } = source(() => resultFactory.ok(stub.facet));
		const session: FixtureSession = { out: "/tmp/out", ...src };
		const device = createDevice({ session, driver: driver(), env: env("http://127.0.0.1:8081") });
		expect(opens()).toBe(0);
		const first = device.devtools;
		expect(opens()).toBe(1);
		expect(device.devtools).toBe(first);
		expect(opens()).toBe(1);
	});
});
