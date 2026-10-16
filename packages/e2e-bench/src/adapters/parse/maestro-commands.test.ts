import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMaestroCommands } from "./maestro-commands";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/maestro", name), "utf8");

describe("parseMaestroCommands", () => {
	test("keeps leaf actions of a real run, drops containers and bookkeeping", () => {
		const r = parseMaestroCommands(fixture("commands-onboarding.json"));
		expect(r.success).toBe(true);
		if (!r.success) return;
		const kinds = new Set(r.data.map((s) => s.kind));
		expect(kinds).toEqual(new Set(["launch", "assert", "tap"]));
		expect(r.data[0]).toEqual({
			kind: "launch",
			label: "launchApp nz.co.delacour.warden.example",
			ms: 1513,
			status: "passed",
		});
		expect(r.data.map((s) => s.label)).toContain("tap #welcome-next");
		expect(r.data.map((s) => s.label)).toContain('assert visible #welcome-title "Plan"');
		expect(r.data.every((s) => s.ms >= 0)).toBe(true);
	});

	test("failed and skipped statuses, selector text, inputText, openLink", () => {
		const json = JSON.stringify([
			{
				command: { tapOnElement: {} },
				metadata: {
					status: "FAILED",
					duration: 5,
					sequenceNumber: 0,
					depth: 0,
					evaluatedCommand: { tapOnElement: { selector: { textRegex: "Open" } } },
				},
			},
			{
				command: { openLinkCommand: {} },
				metadata: {
					status: "COMPLETED",
					duration: 7,
					sequenceNumber: 1,
					depth: 0,
					evaluatedCommand: { openLinkCommand: { link: "warden-example://todo/warden" } },
				},
			},
			{
				command: { inputTextCommand: {} },
				metadata: {
					status: "COMPLETED",
					duration: 9,
					sequenceNumber: 2,
					depth: 0,
					evaluatedCommand: { inputTextCommand: { text: "x" } },
				},
			},
			{
				command: { assertConditionCommand: {} },
				metadata: {
					status: "SKIPPED",
					duration: 1,
					sequenceNumber: 3,
					depth: 0,
					evaluatedCommand: { assertConditionCommand: { condition: { notVisible: { idRegex: "gone" } } } },
				},
			},
		]);
		const r = parseMaestroCommands(json);
		expect(r).toEqual({
			success: true,
			data: [
				{ kind: "tap", label: 'tap "Open"', ms: 5, status: "failed" },
				{ kind: "open", label: "openLink warden-example://todo/warden", ms: 7, status: "passed" },
				{ kind: "fill", label: "inputText", ms: 9, status: "passed" },
				{ kind: "assert", label: "assert notVisible #gone", ms: 1, status: "skipped" },
			],
		});
	});

	test("bad json is an error", () => {
		expect(parseMaestroCommands("nope").success).toBe(false);
		expect(parseMaestroCommands("{}").success).toBe(false);
	});
});
