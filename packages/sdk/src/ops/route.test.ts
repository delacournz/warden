import { describe, expect, test } from "bun:test";
import type { DevtoolsFacet, DevtoolsResult } from "@delacour/warden-devtools/devtools.types";
import { facetStubs } from "@delacour/warden-devtools/testing/facet";
import { resultFactory } from "@delacour/warden-types/result";
import type { DevtoolsDeps } from "./devtools";
import { refStores } from "./ref-store";
import { routeOps } from "./route";
import type { OpSession } from "./session";
import { stateStores } from "./state-store";

const METRO = { metro: "http://127.0.0.1:8081" };

function session(open: DevtoolsDeps["open"]): OpSession {
	return {
		device: { id: "UDID", platform: "ios" },
		host: {
			env: {},
			cwd: "/tmp",
			home: "/tmp",
			now: () => 1,
			exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			sleep: async () => undefined,
		},
		driver: async () => ({ success: false, error: { code: "engine_unavailable", message: "none" } }),
		refs: refStores.createMemoryRefStore(),
		state: stateStores.createMemoryStateStore(),
		timeoutMs: 100,
		devtools: {
			open,
			probe: async () => "ours",
			collector: {
				self: () => ["warden"],
				spawnDetached: () => ({ pid: 1 }),
				kill: () => undefined,
				pidAlive: () => true,
			},
		},
	};
}

function facetReplying(reply: unknown): { open: DevtoolsDeps["open"]; closes: () => number } {
	const stub = facetStubs.create();
	const facet: DevtoolsFacet = {
		...stub.facet,
		evaluate: async () => resultFactory.ok(reply),
	};
	return { open: async (): Promise<DevtoolsResult<DevtoolsFacet>> => resultFactory.ok(facet), closes: stub.closes };
}

describe("route op", () => {
	test("the focused screens joined into the route key, without Expo Router's root wrapper", async () => {
		const { open, closes } = facetReplying(JSON.stringify({ route: ["__root", "(tabs)", "todos"] }));
		const done = await routeOps.route(session(open), METRO);
		expect(done.success && done.data.result).toEqual({ route: "(tabs)/todos" });
		expect(done.success && done.data.text).toBe("(tabs)/todos");
		expect(closes()).toBe(1);
	});

	test("no focused screen yet is an undefined route, not an error", async () => {
		const { open } = facetReplying(JSON.stringify({ route: [] }));
		const done = await routeOps.route(session(open), METRO);
		expect(done.success && done.data.result).toEqual({ route: undefined });
		expect(done.success && done.data.text).toBe("unknown");
	});

	test("a build without the DevTools hook is devtools_unavailable", async () => {
		const { open } = facetReplying(JSON.stringify({ error: "no-hook" }));
		const done = await routeOps.route(session(open), METRO);
		expect(!done.success && done.error.code).toBe("devtools_unavailable");
	});

	test("no Metro for the device is devtools_unavailable", async () => {
		const { open } = facetReplying("{}");
		const s = session(open);
		const unreachable: OpSession = { ...s, devtools: s.devtools && { ...s.devtools, probe: async () => "none" } };
		const done = await routeOps.route(unreachable, {});
		expect(!done.success && done.error.code).toBe("devtools_unavailable");
	});
});
