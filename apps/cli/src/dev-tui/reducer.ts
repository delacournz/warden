import type { DevReady } from "../commands/dev-ui";
import { sanitizeLine } from "./ansi";
import { type Action, actionFor, type Key, type PromptEdit } from "./keys";
import {
	FLASH_MS,
	type Flash,
	type HudBundle,
	type HudFps,
	type HudPerf,
	type HudSample,
	type Mode,
	newTask,
	type Size,
	type Task,
	type TuiState,
} from "./model";

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
	| { type: "hud:sample"; sample: HudSample; fps: HudFps | undefined; at: number }
	/** a perf session started (or ended: undefined); the HUD shows it */
	| { type: "hud:perf"; perf: HudPerf | undefined }
	| { type: "hud:bundle"; bundle: HudBundle }
	/** `warden dev enable|disable hud`: show (and sample) the HUD or not */
	| { type: "hud:visible"; on: boolean }
	| { type: "prompt:open"; label: string }
	| { type: "prompt:edit"; edit: PromptEdit }
	| { type: "prompt:close" }
	/** the clock moved: spinners, running durations and the footer flash follow `now` */
	| { type: "tick"; at: number };

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

const ACTION_ROW = "action:";

/** The footer note for an action row that ended; undefined for the session's own rows. */
function flashFor(state: TuiState, id: string, kind: Flash["kind"], detail: string | undefined, at: number) {
	if (!id.startsWith(ACTION_ROW)) return state.flash;
	const title = state.tasks.find((t) => t.id === id)?.title ?? id.slice(ACTION_ROW.length);
	const first = detail?.split(/\r?\n/).find((line) => line.trim() !== "");
	return { kind, text: first ? `${title} · ${sanitizeLine(first)}` : title, at };
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
		case "run":
			return state;
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

function editPrompt(state: TuiState, edit: PromptEdit): TuiState {
	const { prompt } = state;
	if (!prompt) return state;
	if (edit.op === "char") return { ...state, prompt: { ...prompt, text: prompt.text + edit.char } };
	if (edit.op === "backspace") return { ...state, prompt: { ...prompt, text: [...prompt.text].slice(0, -1).join("") } };
	return state;
}

/** The clock moved; a flash older than `FLASH_MS` goes. */
function tick(state: TuiState, at: number): TuiState {
	const expired = state.flash !== undefined && at - state.flash.at >= FLASH_MS;
	return { ...state, now: at, flash: expired ? undefined : state.flash };
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
			const flashed = { ...done, flash: flashFor(done, event.id, "ok", event.detail, event.at) };
			return event.detail ? withLog(flashed, event.id, event.detail) : flashed;
		}
		case "task:fail": {
			const failed = updateTask({ ...state, now: event.at }, event.id, (task) => ({
				...task,
				status: "fail",
				endedAt: event.at,
			}));
			return withLog(
				{ ...failed, flash: flashFor(failed, event.id, "fail", event.error, event.at) },
				event.id,
				event.error
			);
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
		case "hud:perf":
			return { ...state, hud: { ...state.hud, perf: event.perf } };
		case "prompt:open":
			return { ...state, mode: "prompt", prompt: { label: event.label, text: "" } };
		case "prompt:edit":
			return editPrompt(state, event.edit);
		case "prompt:close":
			return { ...state, mode: "list", prompt: undefined };
		case "hud:sample":
			return { ...state, now: event.at, hud: { ...state.hud, sample: event.sample, fps: event.fps } };
		case "hud:bundle":
			return { ...state, hud: { ...state.hud, bundle: event.bundle } };
		case "hud:visible":
			return { ...state, hud: { ...state.hud, visible: event.on } };
		case "tick":
			return tick(state, event.at);
		case "metro:exit": {
			const noted = withLog({ ...state, now: event.at }, "metro", `metro exited (code ${event.code})`);
			return { ...noted, metroExit: event.code, mode: state.mode === "interact" ? "list" : state.mode };
		}
	}
}
