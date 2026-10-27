import type { DevReady } from "../commands/dev-ui";

export type TaskStatus = "pending" | "running" | "ok" | "fail";

export type Task = {
	/** `DevTaskId` or an action row id (`action:<name>`, see `actions.ts`) */
	id: string;
	title: string;
	status: TaskStatus;
	startedAt: number | undefined;
	endedAt: number | undefined;
	log: string[];
	/** lines scrolled up from the tail; 0 follows the tail */
	scroll: number;
};

/** list: warden's keys; log: the log pane has focus; interact: every key goes to Metro (TUI-4); help: overlay; prompt: the footer takes a line of text (`m` asks for a mark label). */
export type Mode = "list" | "log" | "interact" | "help" | "prompt";

/** What a list-mode key runs (`actions.ts`); each has its own task row, except `reload` which logs on the Metro row. */
export type ActionId =
	| "reload"
	| "show"
	| "open"
	| "screenshot"
	| "reinstall"
	| "restart-sim"
	| "metro-clear"
	| "logs"
	| "perf"
	| "perf-all"
	| "mark"
	| "frames"
	| "report";

/** The footer's one-line input while `mode` is `prompt`. */
export type Prompt = { label: string; text: string };

export type Size = { cols: number; rows: number };

/** One HUD reading: the app is not up yet, not running, or sampled. Memory is RSS on iOS, PSS on Android. */
export type HudSample =
	| { kind: "waiting" }
	| { kind: "not-running" /** why the reading failed, one short line */; reason?: string }
	| {
			kind: "ok";
			cpuPct: number | undefined;
			/** the last CPU readings, oldest first, at most `HUD_HISTORY` */
			cpuHistory: number[];
			memKb: number;
			memKind: "rss" | "pss";
	  };

/** Android frame stats from `dumpsys gfxinfo`; the iOS simulator has none. */
export type HudFps = { fps: number; jankPct: number };

/** Metro's last bundle: set by the Metro pane from its output. */
export type HudBundle = { ms: number; modules: number };

/** A recording `warden perf` session: set by the perf keys (TUI-5) while one records. */
export type HudPerf = { startedAt: number; marks: number };

export type HudState = {
	visible: boolean;
	sample: HudSample | undefined;
	fps: HudFps | undefined;
	bundle: HudBundle | undefined;
	/** when `ready` arrived: the HUD's session clock counts from here */
	sessionStartedAt: number | undefined;
	perf: HudPerf | undefined;
};

/** CPU readings kept for the sparkline. */
export const HUD_HISTORY = 30;

export type TuiState = {
	tasks: Task[];
	selected: number;
	/** false once the person moved the selection: until then it follows the newest running task */
	autoFollow: boolean;
	mode: Mode;
	/** set while `mode` is `prompt` */
	prompt: Prompt | undefined;
	size: Size;
	ready: DevReady | undefined;
	hud: HudState;
	/** set once `q` / Ctrl-C asked to stop; the host reacts to the false to true edge */
	quitting: boolean;
	/** exit code once Metro's PTY has exited */
	metroExit: number | undefined;
	/** bumped by Ctrl-L: the host repaints every row */
	redraw: number;
	/** time of the latest event (the renderer never reads a clock) */
	now: number;
};

const INITIAL_TASKS: ReadonlyArray<{ id: string; title: string }> = [
	{ id: "claim", title: "claim device" },
	{ id: "show", title: "show simulator" },
	{ id: "app", title: "dev build" },
	{ id: "metro", title: "metro" },
	{ id: "client", title: "dev client" },
	{ id: "devtools", title: "devtools" },
	{ id: "session", title: "session" },
];

export function newTask(id: string, title: string): Task {
	return { id, title, status: "pending", startedAt: undefined, endedAt: undefined, log: [], scroll: 0 };
}

export function initialState(size: Size, now: number): TuiState {
	return {
		tasks: INITIAL_TASKS.map((t) => newTask(t.id, t.title)),
		selected: 0,
		autoFollow: true,
		mode: "list",
		prompt: undefined,
		size,
		ready: undefined,
		hud: {
			visible: false,
			sample: undefined,
			fps: undefined,
			bundle: undefined,
			sessionStartedAt: undefined,
			perf: undefined,
		},
		quitting: false,
		metroExit: undefined,
		redraw: 0,
		now,
	};
}

/** Below this the dashboard cannot lay out and shows one line. */
export const MIN_COLS = 60;
export const MIN_ROWS = 16;
