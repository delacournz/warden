import { describe, expect, test } from "bun:test";
import { testContext } from "../testing";
import { createRouteTickerCommand, createSchedulerCommand } from "./condition-processes";
import { COMMANDS } from "./registry";

describe("hidden condition processes", () => {
	test("are registered hidden", () => {
		for (const name of ["__netproxy", "__route-ticker", "__scheduler"]) {
			expect(COMMANDS.find((c) => c.name === name)?.hidden).toBe(true);
		}
	});

	test("__scheduler passes its JSON argument through and returns the run's exit code", async () => {
		const c = testContext(['{"a":1}']);
		const seen: string[] = [];
		const code = await createSchedulerCommand({
			scheduler: async (raw) => {
				seen.push(raw);
				return 2;
			},
		}).run(c);
		expect(code).toBe(2);
		expect(seen).toEqual(['{"a":1}']);
		c.cleanup();
	});

	test("__route-ticker reports a throw as exit 1", async () => {
		const c = testContext(["{}"]);
		const code = await createRouteTickerCommand({
			routeTicker: async () => {
				throw new Error("boom");
			},
		}).run(c);
		expect(code).toBe(1);
		expect(c.stderr.join("\n")).toContain("boom");
		c.cleanup();
	});
});
