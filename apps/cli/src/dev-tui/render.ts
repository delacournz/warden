import { SYMBOLS } from "../ui";
import { fit, sliceColumns, stripAnsi, truncate, visibleWidth, wrap } from "./ansi";
import { EXPO_KEYS, footerHint, LIST_BINDINGS } from "./keys";
import { MIN_COLS, MIN_ROWS, type Task, type TuiState } from "./model";

const ESC = String.fromCharCode(27);
const sgr = (code: string, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`;
const dim = (text: string): string => sgr("2", text);
const bold = (text: string): string => sgr("1", text);
const cyan = (text: string): string => sgr("36", text);
const green = (text: string): string => sgr("32", text);
const red = (text: string): string => sgr("31", text);

/** Width of the task column: a third of the terminal, at most 32. */
export function listWidth(cols: number): number {
	return Math.min(32, Math.floor(cols / 3));
}

/** The HUD slot (TUI-6 fills it) shows from this width. */
export const HUD_MIN_COLS = 100;

/** The HUD box, borders included. */
export const HUD_WIDTH = 34;

/** `412ms`, `1.3s`, `2m05s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function symbolFor(task: Task): string {
	switch (task.status) {
		case "pending":
			return dim(SYMBOLS.idle);
		case "running":
			return cyan(SYMBOLS.run);
		case "ok":
			return green(SYMBOLS.ok);
		case "fail":
			return red(SYMBOLS.fail);
	}
}

function titleFor(task: Task, selected: boolean): string {
	if (task.status === "pending") return dim(task.title);
	if (task.status === "fail") return red(task.title);
	return selected ? bold(task.title) : task.title;
}

function taskRow(task: Task, selected: boolean, width: number): string {
	const marker = selected ? cyan("›") : " ";
	const done =
		(task.status === "ok" || task.status === "fail") && task.startedAt !== undefined && task.endedAt !== undefined;
	const duration = done ? formatDuration((task.endedAt ?? 0) - (task.startedAt ?? 0)) : "";
	const titleWidth = Math.max(1, width - 4 - (duration ? duration.length + 1 : 0));
	const title = fit(titleFor(task, selected), titleWidth);
	return fit(`${marker} ${symbolFor(task)} ${title}${duration ? ` ${dim(duration)}` : ""}`, width);
}

function paneLines(task: Task | undefined): string[] {
	if (!task) return [];
	const lines = task.id === "metro" ? [dim("Metro output appears here"), ...task.log] : task.log;
	if (lines.length > 0) return lines;
	return [dim(task.status === "pending" ? "waiting" : "no output")];
}

/** The Metro pane as the renderer sees it: styled rows (at most the pane's width) and the cursor in them. */
export type RenderPane = { rows: readonly string[]; cursor: { x: number; y: number; visible: boolean } };

/** Rows of the live Metro pane, or undefined while it has nothing to show (the placeholder path then applies). */
function metroPaneRows(task: Task | undefined, state: TuiState, pane: RenderPane | undefined, height: number) {
	if (task?.id !== "metro" || !pane) return undefined;
	let used = pane.rows.length;
	while (used > 0 && stripAnsi(pane.rows[used - 1] ?? "").trim() === "") used--;
	if (used === 0) return undefined;
	if (state.metroExit !== undefined) return [...pane.rows.slice(0, used), ...task.log].slice(-height);
	return Array.from({ length: height }, (_, y) => pane.rows[y] ?? "");
}

/** Where the real cursor goes (0-based screen column and row): the pane's cursor while interacting with a live Metro. */
export function paneCursor(
	state: TuiState,
	cols: number,
	cursor: RenderPane["cursor"]
): { x: number; y: number } | undefined {
	if (state.mode !== "interact" || !cursor.visible || state.metroExit !== undefined) return undefined;
	if (state.tasks[state.selected]?.id !== "metro") return undefined;
	return { x: Math.min(cols - 1, listWidth(cols) + 2 + cursor.x), y: 1 + cursor.y };
}

/** The last `height` wrapped rows of the selected task's log, `scroll` rows above the tail. */
function logWindow(task: Task | undefined, width: number, height: number): string[] {
	const wrapped = paneLines(task).flatMap((line) => wrap(line, width));
	const maxScroll = Math.max(0, wrapped.length - height);
	const scroll = Math.min(task?.scroll ?? 0, maxScroll);
	const end = wrapped.length - scroll;
	return wrapped.slice(Math.max(0, end - height), end);
}

function header(state: TuiState, cols: number): string {
	const { ready } = state;
	const left = `${bold("warden dev")}${dim(ready ? ` · ${ready.platform} · ${ready.projectName}` : "")}`;
	const hud = cols >= HUD_MIN_COLS ? dim(`hud ${state.hud.visible ? "on" : "off"}`) : "";
	const hudWidth = hud ? visibleWidth(hud) + 1 : 0;
	const info = ready ? dim([ready.deviceName ?? ready.deviceId, `:${ready.port}`, ready.metroUrl].join(" · ")) : "";
	const room = cols - visibleWidth(left) - 2 - hudWidth;
	const infoCut = info && room > 0 ? truncate(info, room) : "";
	const gap = Math.max(1, cols - visibleWidth(left) - visibleWidth(infoCut) - hudWidth);
	return fit(`${left}${" ".repeat(gap)}${infoCut}${hud ? ` ${hud}` : ""}`, cols);
}

const SPARK = "▁▂▃▄▅▆▇█";
/** CPU readings shown in the box (the ticker keeps 30; the box only has room for the latest). */
const SPARK_WIDTH = 10;
/** A window that never passes this still draws low bars, so an idle app does not look busy. */
const SPARK_FLOOR_PCT = 20;

function sparkline(values: readonly number[]): string {
	const shown = values.slice(-SPARK_WIDTH);
	const top = Math.max(SPARK_FLOOR_PCT, ...shown);
	return shown
		.map((v) => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round((Math.max(0, v) / top) * (SPARK.length - 1))))])
		.join("");
}

function clock(ms: number, withHours: boolean): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const pad = (n: number): string => String(n).padStart(2, "0");
	const seconds = pad(total % 60);
	const minutes = Math.floor(total / 60);
	return withHours ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${seconds}` : `${pad(minutes)}:${seconds}`;
}

function hudReading(state: TuiState): string[] {
	const { sample, fps } = state.hud;
	if (sample === undefined || sample.kind === "waiting") return [dim("waiting for the app")];
	if (sample.kind === "not-running")
		return sample.reason ? [dim("app not running"), dim(sample.reason)] : [dim("app not running")];
	const pct = sample.cpuPct === undefined ? "  —" : `${String(Math.round(sample.cpuPct)).padStart(3)}%`;
	const mb = `${Math.round(sample.memKb / 1024)} MB`;
	const lines = [`cpu ${pct.padStart(4)} ${cyan(sparkline(sample.cpuHistory))} ${sample.memKind} ${mb}`];
	if (state.ready?.platform !== "android") lines.push(dim("fps —  (iOS sim: no frame API)"));
	else lines.push(fps ? `fps ${Math.round(fps.fps)}  jank ${Math.round(fps.jankPct)}%` : "fps —");
	return lines;
}

function hudBody(state: TuiState): string[] {
	const { bundle, perf } = state.hud;
	const lines = hudReading(state);
	lines.push(bundle ? `metro bundled ${(bundle.ms / 1000).toFixed(1)} s · ${bundle.modules} mods` : dim("metro —"));
	if (perf) lines.push(`perf ${red("●")} rec ${clock(state.now - perf.startedAt, false)}  marks ${perf.marks}`);
	return lines;
}

/**
 * The HUD box (34 columns wide) the top right of the right pane is overlaid with, or undefined when it is off
 * or the terminal is under `HUD_MIN_COLS`. Everything comes from `state.hud`; nothing here reads a clock.
 */
export function hudLines(state: TuiState, cols: number): string[] | undefined {
	if (!state.hud.visible || cols < HUD_MIN_COLS) return undefined;
	const inner = HUD_WIDTH - 2;
	const device = state.ready ? (state.ready.deviceName ?? state.ready.deviceId) : "warden";
	const started = state.hud.sessionStartedAt;
	const time = clock(started === undefined ? 0 : state.now - started, true);
	const name = truncate(device, inner - time.length - 6);
	const head = ` ${name} ── ${time} `;
	const top = dim(`┌${head}${"─".repeat(Math.max(0, inner - visibleWidth(head)))}┐`);
	const side = dim("│");
	const body = hudBody(state).map((line) => `${side}${fit(` ${line}`, inner)}${side}`);
	return [top, ...body, dim(`└${"─".repeat(inner)}┘`)].map((line) => fit(line, HUD_WIDTH));
}

function footer(state: TuiState, cols: number): string {
	if (state.quitting) return fit(dim("stopping… waiting for Metro and the device to release"), cols);
	if (state.mode === "prompt" && state.prompt)
		return fit(
			`${bold(`${state.prompt.label}:`)} ${state.prompt.text}${cyan("▏")}  ${dim(footerHint("prompt"))}`,
			cols
		);
	const task = state.tasks[state.selected];
	const scrolled = state.mode === "log" && task && task.scroll > 0 ? ` · ↑${task.scroll}` : "";
	return fit(dim(`${footerHint(state.mode)}${scrolled}`), cols);
}

function helpBox(cols: number, bodyHeight: number): { rows: string[]; x: number; y: number } {
	const boxWidth = Math.min(cols - 2, 96);
	const inner = boxWidth - 2;
	const gap = 2;
	const colWidth = Math.floor((inner - 2 - gap * 2) / 3);
	const entries = LIST_BINDINGS.filter((b) => !b.hidden).map((b) => `${b.label.padEnd(8)} ${b.desc}`);
	const split = Math.ceil(entries.length / 2);
	const warden = [entries.slice(0, split), entries.slice(split)];
	const expo = EXPO_KEYS.map((k) => `${k.label.padEnd(8)} ${k.desc}`);
	const lineCount = Math.max(split, expo.length);
	const cell = (text: string | undefined): string => fit(text ?? "", colWidth);
	const row = (a: string | undefined, b: string | undefined, c: string | undefined): string =>
		fit(` ${cell(a)}${" ".repeat(gap)}${cell(b)}${" ".repeat(gap)}${cell(c)}`, inner);
	const body = [
		row(bold("warden"), "", bold("Expo (interact)")),
		...Array.from({ length: lineCount }, (_, i) => row(warden[0]?.[i], warden[1]?.[i], expo[i])),
		row(dim("tab: scroll the log"), "", dim("esc ? q close")),
	];
	const title = " keys ";
	const top = `┌${title}${"─".repeat(Math.max(0, inner - title.length))}┐`;
	const rows = [top, ...body.map((line) => `│${line}│`), `└${"─".repeat(inner)}┘`].map((line) => fit(line, boxWidth));
	return { rows, x: Math.floor((cols - boxWidth) / 2), y: Math.max(0, Math.floor((bodyHeight - rows.length) / 2)) };
}

/** Pure: the whole frame as `rows` strings of exactly `cols` visible columns. */
export function render(state: TuiState, cols: number, rows: number, pane?: RenderPane): string[] {
	if (cols < MIN_COLS || rows < MIN_ROWS) {
		return [fit("terminal too small", cols), ...Array.from({ length: Math.max(0, rows - 1) }, () => " ".repeat(cols))];
	}
	const bodyHeight = rows - 2;
	const left = listWidth(cols);
	const right = cols - left - 1;
	const selectedTask = state.tasks[state.selected];
	const log = metroPaneRows(selectedTask, state, pane, bodyHeight) ?? logWindow(selectedTask, right - 1, bodyHeight);
	const divider = state.mode === "log" ? cyan("│") : dim("│");
	let body = Array.from({ length: bodyHeight }, (_, y) => {
		const task = state.tasks[y];
		const listCell = task ? taskRow(task, y === state.selected, left) : " ".repeat(left);
		return `${listCell}${divider}${fit(` ${log[y] ?? ""}`, right)}`;
	});
	const hudBox = hudLines(state, cols);
	if (hudBox) {
		const x = cols - HUD_WIDTH;
		body = body.map((line, y) => {
			const boxRow = hudBox[y];
			return boxRow === undefined ? line : `${sliceColumns(line, 0, x)}${boxRow}`;
		});
	}
	if (state.mode === "help") {
		const box = helpBox(cols, bodyHeight);
		body = body.map((line, y) => {
			const boxRow = box.rows[y - box.y];
			if (boxRow === undefined) return line;
			return `${sliceColumns(line, 0, box.x)}${boxRow}${sliceColumns(line, box.x + visibleWidth(boxRow), cols)}`;
		});
	}
	return [header(state, cols), ...body.map((line) => fit(line, cols)), footer(state, cols)];
}
