import { describe, expect, test } from "bun:test";
import type { AppPhase } from "@delacour/warden-core/builds/resolve";
import { appPhaseText, phaseTracker } from "./app-phase";

const text = (...entries: Array<[string, AppPhase]>) => appPhaseText(new Map(entries));
const building: AppPhase = { phase: "building", platform: "ios", hash: "b1fee19abcdef:base" };

describe("appPhaseText", () => {
	test("a build says building with the short fingerprint", () => {
		expect(text(["prepare:ios", building])).toBe("building the ios app (fingerprint b1fee19)…");
	});

	test("fetching, repacking and waiting each have their own line", () => {
		expect(text(["a", { phase: "fetching", source: "eas" }])).toBe("fetching the EAS build…");
		expect(text(["a", { phase: "repacking", platform: "ios", jsKey: "j" }])).toBe(
			"repacking JS into the simulator build…"
		);
		expect(text(["a", { phase: "waiting" }])).toBe("waiting for the app build…");
	});

	test("never installing while any source is still pending", () => {
		expect(text(["d1", { phase: "installing" }], ["prepare:ios", building], ["d2", { phase: "installing" }])).toBe(
			"building the ios app (fingerprint b1fee19)…"
		);
	});

	test("the building line beats a device that is only waiting on it", () => {
		expect(text(["d1", { phase: "waiting" }], ["d2", building])).toContain("building the ios app");
	});

	test("installing counts the devices installing; ready ones do not", () => {
		expect(text(["d1", { phase: "installing" }], ["d2", { phase: "installing" }], ["d3", { phase: "ready" }])).toBe(
			"installing the app on 2 device(s)…"
		);
	});

	test("nothing to say when everything is ready or nothing was reported", () => {
		expect(text(["d1", { phase: "ready" }])).toBeUndefined();
		expect(text()).toBeUndefined();
	});
});

describe("phaseTracker", () => {
	test("updates the spinner on each change, not on repeats; build → install reads in order", () => {
		const lines: string[] = [];
		const on = phaseTracker((line) => lines.push(line));
		on("prepare:ios", building);
		on("prepare:ios", building);
		on("d1", { phase: "waiting" });
		on("prepare:ios", { phase: "ready" });
		on("d1", { phase: "installing" });
		on("d2", { phase: "installing" });
		on("d1", { phase: "ready" });
		expect(lines).toEqual([
			"building the ios app (fingerprint b1fee19)…",
			"waiting for the app build…",
			"installing the app on 1 device(s)…",
			"installing the app on 2 device(s)…",
			"installing the app on 1 device(s)…",
		]);
	});
});
