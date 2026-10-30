/**
 * Demo-video kit types: a definition (what to record and how to caption it),
 * the recorder's output (`steps.json`) and the render plan (`plan.json`) that
 * `render.py` draws from. No times live in a definition except pauses: every
 * on-screen time is measured by `record.ts`.
 */

/** What the terminal prints under a command; `ok` draws a vector check mark first. */
export type DemoOutput = { kind: "ok"; text: string } | { kind: "plain"; text: string };

export type DemoStep = {
	/** Arguments after `warden`, e.g. `["ui", "press", "id=bio-unlock"]`. `--udid` is appended by the recorder. */
	argv: readonly string[];
	/** Hidden steps run (retries, setup) but are not captioned; use for anything with no visible effect. */
	hidden?: boolean;
	/** Override of the printed command; defaults to `warden <argv>`. Never print a command that was not run. */
	shown?: string;
	/** Printed when the step ends. Required for captioned steps. */
	output: DemoOutput;
	/** Idle time after the step so the viewer sees the result. */
	pauseAfterMs: number;
};

export type DemoApp = {
	bundleId: string;
	kind: "dev" | "simulator" | "release";
	/** Project directory, relative to the repo root; the CLI runs from here. */
	project: string;
	/** Opened with `--settle` after the app launches. */
	deepLink?: string;
	/** System appearance for the take (`simctl ui appearance`), restored afterwards. Match it to the frame: `render.py` draws the docs dark palette. */
	appearance?: "light" | "dark";
};

export type DemoDefinition = {
	name: string;
	title: string;
	subtitle: string;
	/** Terminal window title. */
	terminalTitle: string;
	/** Bottom-left / bottom-right footer text. */
	footer: { left: string; right: string };
	/** Line under the phone; defaults to `DEFAULT_PHONE_CAPTION`. Every take is a real simulator (honesty rules). */
	phoneCaption?: string;
	platform: "ios";
	claim: { biometrics?: boolean; profile?: string };
	app: DemoApp;
	/**
	 * `warden ui wait` selectors that must pass (after the deep link, before the video starts) so no step
	 * presses a screen that has not mounted. E.g. `["id=bio-screen", "id=bio-unlock"]`.
	 */
	ready: readonly string[];
	/** Idle before the first step. */
	leadInMs: number;
	steps: readonly DemoStep[];
	/** Comment line typed after the last step. */
	outro: string;
	/** Last frame held after the outro appears (the take records ~1 s of it; the renderer pads). */
	tailHoldMs: number;
};

export type RecordedStep = {
	index: number;
	/** Seconds since the video started. */
	startS: number;
	endS: number;
};

/** Written by `record.ts` next to `take.mp4`. */
export type RecordedTake = {
	name: string;
	udid: string;
	steps: readonly RecordedStep[];
	/** Wall clock of the whole recording, seconds. */
	recordedS: number;
};

export type PlanStep = {
	shown: string;
	output: DemoOutput;
	/** Typing begins / command fires / output appears, seconds. */
	typeStartS: number;
	fireS: number;
	outputS: number;
};

export type TerminalLayout = {
	/** Vertical distance between entries. */
	entryPitch: number;
	/** Output line offset below its command. */
	outputOffset: number;
	fontPx: number;
	/** Entries that fit when scrolling. */
	visibleEntries: number;
	/** True when the entries do not fit at a legible size; the oldest scroll away. */
	scroll: boolean;
};

export type RenderPlan = {
	title: string;
	subtitle: string;
	terminalTitle: string;
	footer: { left: string; right: string };
	phoneCaption: string;
	steps: readonly PlanStep[];
	outro: string;
	outroS: number;
	durationS: number;
	fps: number;
	layout: TerminalLayout;
	fontsDir: string;
};
