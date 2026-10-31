import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { expectedRunnerIdentity } from "./identity";
import { readServedIdentity, removeServedIdentity, runnerIdentityPath, writeServedIdentity } from "./served-identity";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("served identity file", () => {
	test("round-trips next to the socket and is removed", () => {
		ctx = testContext([]);
		const socket = join(ctx.cwd, "r.sock");
		expect(runnerIdentityPath(socket)).toBe(`${socket}.build.json`);
		expect(readServedIdentity(socket)).toBeUndefined();
		writeServedIdentity(socket, "/c/dd");
		expect(readServedIdentity(socket)).toBe("/c/dd");
		removeServedIdentity(socket);
		expect(readServedIdentity(socket)).toBeUndefined();
		removeServedIdentity(socket);
	});

	test("a torn or foreign file reads as no identity", () => {
		ctx = testContext([]);
		const socket = join(ctx.cwd, "r.sock");
		writeFileSync(runnerIdentityPath(socket), "{not json");
		expect(readServedIdentity(socket)).toBeUndefined();
		writeFileSync(runnerIdentityPath(socket), JSON.stringify({ derivedData: 3 }));
		expect(readServedIdentity(socket)).toBeUndefined();
	});
});

describe("expectedRunnerIdentity", () => {
	test("asks the core for the derived data with the config team and the sources of this build", async () => {
		ctx = testContext([]);
		const seen: Array<{ team: string | undefined; version: boolean }> = [];
		const id = await expectedRunnerIdentity(ctx, {
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
		ctx = testContext([]);
		const id = await expectedRunnerIdentity(ctx, {
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
