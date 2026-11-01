import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliTesting, type TestContext } from "../testing";
import { runnerIdentity } from "./identity";
import { servedIdentity } from "./served-identity";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("served identity file", () => {
	test("round-trips next to the socket and is removed", () => {
		ctx = cliTesting.testContext([]);
		const socket = join(ctx.cwd, "r.sock");
		expect(servedIdentity.runnerIdentityPath(socket)).toBe(`${socket}.build.json`);
		expect(servedIdentity.readServedIdentity(socket)).toBeUndefined();
		servedIdentity.writeServedIdentity(socket, "/c/dd");
		expect(servedIdentity.readServedIdentity(socket)).toBe("/c/dd");
		servedIdentity.removeServedIdentity(socket);
		expect(servedIdentity.readServedIdentity(socket)).toBeUndefined();
		servedIdentity.removeServedIdentity(socket);
	});

	test("a torn or foreign file reads as no identity", () => {
		ctx = cliTesting.testContext([]);
		const socket = join(ctx.cwd, "r.sock");
		writeFileSync(servedIdentity.runnerIdentityPath(socket), "{not json");
		expect(servedIdentity.readServedIdentity(socket)).toBeUndefined();
		writeFileSync(servedIdentity.runnerIdentityPath(socket), JSON.stringify({ derivedData: 3 }));
		expect(servedIdentity.readServedIdentity(socket)).toBeUndefined();
	});
});

describe("expectedRunnerIdentity", () => {
	test("asks the core for the derived data with the config team and the sources of this build", async () => {
		ctx = cliTesting.testContext([]);
		const seen: Array<{ team: string | undefined; version: boolean }> = [];
		const id = await runnerIdentity.expectedRunnerIdentity(ctx, {
			expected: async (input) => {
				seen.push({ team: input.configTeamId, version: typeof input.loadSources === "function" });
				return { success: true, data: "/h/dd" };
			},
			build: () => ({ channel: "release", version: "1" }),
			iosConfig: () => ({ teamId: "ABCDE12345" }),
		});
		expect(id).toBe("/h/dd");
		expect(seen).toEqual([{ team: "ABCDE12345", version: true }]);
	});

	test("a failure is no identity, not an error", async () => {
		ctx = cliTesting.testContext([]);
		const id = await runnerIdentity.expectedRunnerIdentity(ctx, {
			expected: async () => ({
				success: false,
				error: { code: "no_team", message: "m", hint: "h" },
			}),
			build: () => ({ channel: "release", version: "1" }),
			iosConfig: () => ({}),
		});
		expect(id).toBeUndefined();
	});
});
