/**
 * Demo-video kit types: a definition (what to record and how to caption it),
 * the recorder's output (`steps.json`) and the render plan (`plan.json`) that
 * `render.py` draws from. No times live in a definition except pauses: every
 * on-screen time is measured by `record.ts`.
 */

/**
 * What the terminal prints under a command; `ok` draws a vector check mark first, `lines` prints up to ~6 muted
 * lines (code quoted from a file: pair it with `DemoStep.quote` so every line is proven to be in that file).
 */
export type DemoOutput =
	| { kind: "ok"; text: string }
	| { kind: "plain"; text: string }
	| { kind: "lines"; text: readonly string[] };

/** A `setup` step; `optional` logs a non-zero exit instead of throwing (a permission prompt that may not show). */
export type SetupStep = { argv: readonly string[]; optional?: true };

export type DemoStep = {
	/** Arguments after `warden`, e.g. `["ui", "press", "id=bio-unlock"]`. `--udid` is appended by the recorder. */
	argv: readonly string[];
	/** Hidden steps run (retries, setup) but are not captioned; use for anything with no visible effect. */
	hidden?: boolean;
	/** Override of the printed command; defaults to `warden <argv>`. Never print a command that was not run. */
	shown?: string;
	/** Printed when the step ends. Required for captioned steps. */
	output: DemoOutput;
	/** After the step, every line of a `lines` output (trimmed) must occur in this file (relative to `app.project`). */
	quote?: { file: string };
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
	 * `warden` argv run after the app opens and before the deep link, off camera (`--udid` appended, or `{udid}` substituted where an argv has it). E.g.
	 * `["ui", "network", "set", "online", "--relaunch"]` relaunches the iOS app with warden's network dylib, so
	 * network and clock steps reach it live.
	 */
	setup?: readonly (readonly string[] | SetupStep)[];
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
	/** Vertical distance between the lines of a `lines` output. */
	lineGap: number;
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

/** One step of a `warden dev` take: wait for something, then do something, then wait for the effect. */
export type DevBeat = {
	id: string;
	/** Caption drawn under the TUI from the moment the beat acts until the next beat acts. */
	caption: string;
	/** Regex source that must match the TUI frame (rows joined by newlines) before the beat acts. */
	waitScreen?: string;
	/** `warden ui wait` selectors that must pass on the phone before the beat acts. */
	waitPhone?: readonly string[];
	/** Raw bytes typed into the TUI, e.g. `"h"`. */
	keys?: string;
	/** A real edit of a source file (repo-relative); reverted in `finally`. */
	edit?: { file: string; from: string; to: string };
	/** `warden ui wait` selectors that must pass on the phone after the action (the HMR landing). */
	afterPhone?: readonly string[];
	/** Wait until the simulator is up and its video is running (a script take starts the video after the boot) and it shows its home screen rather than the boot logo (polled with screenshots, up to 120 s). */
	waitBoot?: boolean;
	/** Stop the simulator video before the action (the action ends the lease, after which `warden ui` refuses). */
	stopVideoFirst?: boolean;
	/** Waiting budget for every wait of the beat. */
	timeoutMs: number;
	/** Idle time after the beat so the viewer sees the result. */
	pauseAfterMs: number;
	/** Speed up the waiting part of the beat (before it acts) by this factor; shown on screen as a speed tag. */
	ramp?: number;
};

export type DevDemoDefinition = {
	name: string;
	platform: "ios";
	claim: { profile?: string };
	app: { bundleId: string; project: string; appearance?: "light" | "dark" };
	/** Extra argv after `dev ios --lease <id>`. */
	devArgs: readonly string[];
	/**
	 * Run this shell script under the PTY instead of `warden dev` (for clips about another command, e.g. `warden claim`).
	 * `warden` is a function running this checkout's CLI and `{label}` is the take's lease label; the device is the one the
	 * script claims under that label. The lease is released by label after the take. Prompt lines are printed, not typed.
	 */
	script?: string;
	/**
	 * Record the simulator with `simctl io recordVideo` instead of `warden ui screen video`. warden's helper attaches a
	 * driver to the device, which a command that drives the same device itself (`warden e2e`) cannot share.
	 */
	rawVideo?: boolean;
	/** Extra env for the `warden dev` child (and so Metro / Expo CLI). Only for things that drop noise, never behaviour. */
	devEnv?: Readonly<Record<string, string>>;
	/** Uninstall the app as soon as the claimed udid is known so `warden dev` installs it from the build cache on camera. */
	uninstallFirst: boolean;
	cols: number;
	rows: number;
	/** Shown above the terminal card. */
	terminalTitle: string;
	footer: { left: string; right: string };
	beats: readonly DevBeat[];
	tailHoldMs: number;
	/** Beat whose action frame (+1 s) is the poster. */
	posterBeat: string;
};

export type RecordedBeat = {
	id: string;
	/** Seconds on the master clock (origin = the `warden dev` spawn). */
	startS: number;
	/** The waits passed; the action runs now. */
	readyS: number;
	/** Action done and the after-wait passed. */
	endS: number;
};

/** Written by `dev-take.ts` next to `take.mp4` and `tui.cast`. */
export type DevTake = {
	name: string;
	udid: string;
	/** `RecordDeps.now()` at the spawn: lines several takes recorded in one process up on one clock. */
	startedAtS: number;
	beats: readonly RecordedBeat[];
	recordedS: number;
	/** Master clock origin is the `warden dev` spawn; seconds from it to the simulator video's first frame. */
	videoStartS: number;
	/** Master-clock second where the dashboard left the alt screen (the cast stops there); null = never seen. */
	exitS: number | null;
	/** `warden ls` after exit showed neither the device lease (label) nor the Metro port lease of this session. */
	released: boolean;
};

/** One caption of a multi-lane reel; it runs from `at` until the next caption. */
export type LanesCaption = {
	text: string;
	/** `start` = the first spawn, `meet` = every lane reached `meetBeat`, `shell` = the shell command starts typing. */
	at: "start" | "meet" | "shell";
};

/**
 * Several `warden dev` sessions at once, each in its own checkout (a git worktree) with its own simulator, then one
 * shell command (`warden ls`) over all of them. Every lane is a full `DevDemoDefinition` take.
 */
export type LanesDemoDefinition = {
	name: string;
	/** Beats, size and env every lane shares. */
	base: DevDemoDefinition;
	lanes: readonly {
		/** Checkout directory name inside the worktrees dir. */
		checkout: string;
		/** `warden dev --label` and the lease label `warden ls` shows. */
		label: string;
		/** Card title. */
		title: string;
	}[];
	/** Delay between the lanes' spawns, in order. */
	staggerMs: number;
	/** Every lane holds after this beat until all have reached it and the shell command has run. */
	meetBeat: string;
	shell: {
		cols: number;
		rows: number;
		title: string;
		/** Typed after a prompt, then run for real with `sh -c`. */
		command: string;
	};
	captions: readonly LanesCaption[];
	footer: { right: string };
	/** Hold after the shell command's output, before the lanes quit. */
	shellHoldMs: number;
	/** Take whose frame is the poster: the moment after the shell output. */
	posterAfterShellS: number;
};
