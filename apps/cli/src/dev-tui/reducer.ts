import type { DevReady } from "../commands/dev-ui";
import { sanitizeLine } from "./ansi";
import { type Action, actionFor, type Key } from "./keys";
import { type HudFps, type HudSample, type Mode, newTask, type Size, type Task, type TuiState } from "./model";

export type TuiEvent =
	| { type: "task:start"; id: string; title: string; at: number }
	| { type: "task:ok"; id: string; detail: string | undefined; at: number }
	| { type: "task:fail"; id: string; error: string; at: number }
	| { type: "task:log"; id: string; line: string }
	| { type: "task:title"; id: string; title: string }
	| { type: "key"; key: Key; at: number }
	| { type: "resize"; size: Size }
	| { type: "mode"; mode: Mode }
	| { type: "ready"; info: DevReady; at: number }
	| { type: "metro:exit"; code: number; at: number }
	| { type: "hud:sample"; sample: HudSample; fps: HudFps | undefined; at: number };

/** Lines kept per task; older ones drop off the front. */
export const MAX_LOG_LINES = 5000;

function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(sanitizeLine)
		.filter((line, i, all) => line !== "" || i < all.length - 1);
}

function updateTask(state: TuiState, id: string, change: (task: Task) => Task): TuiState {
	const index = state.tasks.findIndex((t) => t.id === id);
	if (index === -1) return state;
	const tasks = state.tasks.slice();
	const current = tasks[index];
	if (current) tasks[index] = change(current);
	return { ...state, tasks };
}

function appendLines(task: Task, text: string): Task {
	const added = splitLines(text);
	if (added.length === 0) return task;
	const log = [...task.log, ...added];
	const trimmed = log.length > MAX_LOG_LINES ? log.slice(log.length - MAX_LOG_LINES) : log;
	return { ...task, log: trimmed, scroll: task.scroll > 0 ? task.scroll + added.length : 0 };
}

function withLog(state: TuiState, id: string, text: string): TuiState {
	return updateTask(state, id, (task) => appendLines(task, text));
}

function follow(state: TuiState, id: string): TuiState {
	if (!state.autoFollow) return state;
	const index = state.tasks.findIndex((t) => t.id === id);
	return index === -1 ? state : { ...state, selected: index };
}

function ensureTask(state: TuiState, id: string, title: string): TuiState {
	if (state.tasks.some((t) => t.id === id)) return state;
	return { ...state, tasks: [...state.tasks, newTask(id, title)] };
}

function readyLines(info: DevReady): string[] {
	const device = info.deviceName ? `${info.deviceName} (${info.deviceId})` : info.deviceId;
	const lines = [`${info.platform} · ${device}`, `metro  ${info.metroUrl}`];
	if (info.app) lines.push(`app    ${info.app.source} ${info.app.hash}`);
	lines.push("", "holding the device and port until you quit", "q or ctrl-c stops Metro and releases · ? for keys");
	return lines;
}

function clampScroll(task: Task, scroll: number): Task {
	return { ...task, scroll: Math.max(0, Math.min(scroll, Math.max(0, task.log.length - 1))) };
}

function applyAction(state: TuiState, action: Action): TuiState {
	switch (action.type) {
		case "select": {
			const selected = Math.max(0, Math.min(state.tasks.length - 1, state.selected + action.delta));
			return { ...state, selected, autoFollow: false };
		}
		case "scroll": {
			const page = Math.max(1, state.size.rows - 3);
			return updateTask(state, state.tasks[state.selected]?.id ?? "", (task) => {
				switch (action.kind) {
					case "line":
						return clampScroll(task, task.scroll + action.dir);
					case "page":
						return clampScroll(task, task.scroll + action.dir * page);
					case "top":
						return clampScroll(task, task.log.length);
					case "bottom":
						return { ...task, scroll: 0 };
				}
			});
		}
		case "mode":
			return { ...state, mode: action.mode };
		case "interact": {
			const metro = state.tasks.findIndex((t) => t.id === "metro");
			return metro === -1 ? state : { ...state, selected: metro, autoFollow: false, mode: "interact" };
		}
		case "forward":
		case "pane-scroll":
			return state;
		case "hud":
			return { ...state, hud: { ...state.hud, visible: !state.hud.visible } };
		case "redraw":
			return { ...state, redraw: state.redraw + 1 };
		case "unavailable": {
			const id = state.tasks[state.selected]?.id ?? "";
			return withLog(state, id, `${action.label}: not available yet`);
		}
		case "quit": {
			if (state.quitting) return state;
			const stopped = ensureTask({ ...state, quitting: true }, "session", "session");
			return updateTask(stopped, "session", (task) =>
				appendLines(
					{
						...task,
						title: "stopping…",
						status: "running",
						startedAt: task.startedAt ?? state.now,
						endedAt: undefined,
					},
					"stopping…"
				)
			);
		}
	}
}

export function reduce(state: TuiState, event: TuiEvent): TuiState {
	switch (event.type) {
		case "task:start": {
			const base = ensureTask({ ...state, now: event.at }, event.id, event.title);
			const started = updateTask(base, event.id, (task) => ({
				...task,
				title: event.title,
				status: "running",
				startedAt: event.at,
				endedAt: undefined,
			}));
			return follow(started, event.id);
		}
		case "task:ok": {
			const done = updateTask({ ...state, now: event.at }, event.id, (task) => ({
				...task,
				status: "ok",
				endedAt: event.at,
			}));
			return event.detail ? withLog(done, event.id, event.detail) : done;
		}
		case "task:fail": {
			const failed = updateTask({ ...state, now: event.at }, event.id, (task) => ({
				...task,
				status: "fail",
				endedAt: event.at,
			}));
			return withLog(failed, event.id, event.error);
		}
		case "task:log":
			return withLog(state, event.id, event.line);
		case "task:title":
			return updateTask(state, event.id, (task) => ({ ...task, title: event.title }));
		case "key": {
			const next = { ...state, now: event.at };
			const action = actionFor(state.mode, event.key);
			return action ? applyAction(next, action) : next;
		}
		case "resize":
			return { ...state, size: event.size };
		case "mode":
			return { ...state, mode: event.mode };
		case "ready": {
			const base = ensureTask(
				{ ...state, ready: event.info, now: event.at, hud: { ...state.hud, sessionStartedAt: event.at } },
				"session",
				"session"
			);
			const running = updateTask(base, "session", (task) => ({
				...appendLines(task, readyLines(event.info).join("\n")),
				title: state.quitting ? "stopping…" : "session",
				status: "running",
				startedAt: event.at,
				endedAt: undefined,
			}));
			return follow(running, "session");
		}
		case "hud:sample":
			return { ...state, now: event.at, hud: { ...state.hud, sample: event.sample, fps: event.fps } };
		case "metro:exit": {
			const noted = withLog({ ...state, now: event.at }, "metro", `metro exited (code ${event.code})`);
			return { ...noted, metroExit: event.code, mode: state.mode === "interact" ? "list" : state.mode };
		}
	}
}
