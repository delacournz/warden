import { describe, expect, test } from "bun:test";
import type { DevBeat, DevDemoDefinition, DevTake } from "./demo.types";
import { buildDevFiltergraph, DEV_LAYOUT, fitBox, mp4Args } from "./dev-render";
import { buildSegments } from "./dev-timeline";

const beat = (id: string, o: Partial<DevBeat> = {}): DevBeat => ({
	id,
	caption: id,
	timeoutMs: 1,
	pauseAfterMs: 0,
	...o,
});
const def: DevDemoDefinition = {
	name: "dev/x",
	platform: "ios",
	claim: {},
	app: { bundleId: "x", project: "apps/example" },
	devArgs: [],
	uninstallFirst: false,
	cols: 100,
	rows: 34,
	terminalTitle: "t",
	footer: { left: "", right: "" },
	tailHoldMs: 0,
	posterBeat: "b",
	beats: [beat("a"), beat("b")],
};
const take: DevTake = {
	name: "dev/x",
	udid: "u",
	startedAtS: 0,
	videoStartS: 1.2,
	exitS: null,
	released: true,
	recordedS: 20,
	beats: [
		{ id: "a", startS: 0, readyS: 1, endS: 1 },
		{ id: "b", startS: 1, readyS: 15, endS: 16 },
	],
};

describe("fitBox", () => {
	test("keeps the aspect inside the box, even sized and centred", () => {
		const b = fitBox({ x: 10, y: 10, w: 1000, h: 400 }, 2);
		expect(b).toEqual({ x: 110, y: 10, w: 800, h: 400 });
	});
});

describe("buildDevFiltergraph", () => {
	const segments = buildSegments(20, [{ fromS: 3, toS: 13, speed: 5 }]);
	const g = buildDevFiltergraph({
		def,
		take,
		segments,
		tuiBox: { x: 68, y: 108, w: 1260, h: 800 },
		padS: 5,
		hold: 1.5,
		monoFont: "/f.ttf",
		workDir: "/w",
	});
	test("retimes both clips through every segment and concatenates", () => {
		expect(g.graph.match(/concat=n=3/g)?.length).toBe(2);
		expect(g.graph).toContain("trim=start=3:end=13,setpts=(PTS-STARTPTS)/5");
	});
	test("the phone is black until its video starts, on the master clock", () => {
		expect(g.graph).toContain("tpad=start_duration=1.2:start_mode=add:color=black");
	});
	test("both clips hold their last frame through the end hold", () => {
		expect(g.graph).toContain("[prr]tpad=stop_mode=clone:stop_duration=1.5[pr]");
		expect(g.graph).toContain("[trr]tpad=stop_mode=clone:stop_duration=1.5[tr]");
	});
	test("overlays the phone at its ring slot and the TUI at its box", () => {
		expect(g.graph).toContain(`overlay=${DEV_LAYOUT.phone.x}:${DEV_LAYOUT.phone.y}`);
		expect(g.graph).toContain("overlay=68:108");
	});
	test("a caption per beat and a speed tag for the ramp", () => {
		expect(g.texts.map((t) => t.text)).toEqual(["a", "b", "× 5 speed"]);
	});
});

describe("mp4Args", () => {
	test("h264 faststart yuv420p 30 fps", () => {
		const a = mp4Args("i.mp4", "o.mp4", 24).join(" ");
		expect(a).toContain("-movflags +faststart");
		expect(a).toContain("-pix_fmt yuv420p");
		expect(a).toContain("-r 30");
	});
});
