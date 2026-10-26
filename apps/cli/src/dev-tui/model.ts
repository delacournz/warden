import type { DevReady } from "../commands/dev-ui";

export type TaskStatus = "pending" | "running" | "ok" | "fail";

export type Task = {
	/** `DevTaskId` or an action row id (TUI-5) */
	id: string;
	title: string;
	status: TaskStatus;
	startedAt: number | undefined;
	endedAt: number | undefined;
	log: string[];
	/** lines scrolled up from the tail; 0 follows the tail */
	scroll: number;
};

/** list: warden's keys; log: the log pane has focus; interact: every key goes to Metro (TUI-4); help: overlay. */
export type Mode = "list" | "log" | "interact" | "help";

export type Size = { cols: number; rows: number };

export type TuiState = {
	tasks: Task[];
	selected: number;
	/** false once the person moved the selection: until then it follows the newest running task */
	autoFollow: boolean;
	mode: Mode;
	size: Size;
	ready: DevReady | undefined;
	hud: boolean;
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
		size,
		ready: undefined,
		hud: false,
		quitting: false,
		metroExit: undefined,
		redraw: 0,
		now,
	};
}

/** Below this the dashboard cannot lay out and shows one line. */
export const MIN_COLS = 60;
export const MIN_ROWS = 16;
