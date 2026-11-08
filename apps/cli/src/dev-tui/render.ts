import { SYMBOLS } from "../ui";
import { fit, sliceColumns, stripAnsi, truncate, visibleWidth, wrap } from "./ansi";
import { type Binding, EXPO_KEYS, footerHint, KEY_GROUP_TITLES, type KeyGroup, LIST_BINDINGS } from "./keys";
import { FLASH_MS, MIN_COLS, MIN_ROWS, type Task, type TuiState } from "./model";

const ESC = String.fromCharCode(27);
const sgr = (code: string, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`;
const dim = (text: string): string => sgr("2", text);
const bold = (text: string): string => sgr("1", text);
const cyan = (text: string): string => sgr("36", text);
const green = (text: string): string => sgr("32", text);
const red = (text: string): string => sgr("31", text);

/** Inverse video across a whole row, kept through the resets of the styles inside it. */
function highlight(row: string): string {
	return `${ESC}[7m${row.replaceAll(`${ESC}[0m`, `${ESC}[0;7m`)}${ESC}[0m`;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** One spinner frame; also how often the host ticks while something spins. */
export const SPIN_MS = 100;
/** How often the host ticks while only the live session (or a footer flash) needs the clock. */
export const SLOW_TICK_MS = 1000;
const FLASH_TICK_MS = 500;

/** The long-lived session row is live, not busy: it gets a dot instead of a spinner until it is stopping. */
function spins(task: Task, state: TuiState): boolean {
	return task.status === "running" && (task.id !== "session" || state.quitting);
}

/**
 * How often the host should send `tick` for this state, or undefined when nothing on screen follows the clock:
 * a spinner wants frames, a running duration or the footer flash only seconds.
 */
export function tickInterval(state: TuiState): number | undefined {
	if (state.tasks.some((task) => spins(task, state))) return SPIN_MS;
	if (state.flash !== undefined) return FLASH_TICK_MS;
	if (state.tasks.some((task) => task.status === "running")) return SLOW_TICK_MS;
	return undefined;
}

/** Width of the task column: a third of the terminal, at most 32. */
export function listWidth(cols: number): number {
	return Math.min(32, Math.floor(cols / 3));
}

/** The HUD box shows from this width. */
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

/** `7s`, `2m05s`, `1h04m`: a running task's age, whole seconds so it does not flicker. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function symbolFor(task: Task, state: TuiState): string {
	switch (task.status) {
		case "pending":
			return dim(SYMBOLS.idle);
		case "running":
			if (!spins(task, state)) return green("●");
			return cyan(SPINNER[Math.floor(state.now / SPIN_MS) % SPINNER.length] ?? SYMBOLS.run);
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

/** How long a task took, or has been running; empty while pending. */
function durationOf(task: Task, now: number): string {
	if (task.startedAt === undefined) return "";
	if (task.status === "running") return formatElapsed(now - task.startedAt);
	if (task.endedAt === undefined || task.status === "pending") return "";
	return formatDuration(task.endedAt - task.startedAt);
}

/** A task row; the selected one is a highlight bar while the list has focus, a marker otherwise. */
function taskRow(task: Task, selected: boolean, state: TuiState, width: number): string {
	const marker = selected ? cyan("›") : " ";
	const duration = durationOf(task, state.now);
	const titleWidth = Math.max(1, width - 4 - (duration ? duration.length + 1 : 0));
	const title = fit(titleFor(task, selected), titleWidth);
	const row = fit(`${marker} ${symbolFor(task, state)} ${title}${duration ? ` ${dim(duration)}` : ""}`, width);
	return selected && listFocused(state) ? highlight(row) : row;
}

function listFocused(state: TuiState): boolean {
	return state.mode === "list" || state.mode === "help" || state.mode === "prompt";
}

/** What the pane title says about the task's state. */
function statusText(task: Task, state: TuiState): string {
	const duration = durationOf(task, state.now);
	if (task.id === "metro" && state.metroExit !== undefined) {
		const exited = `exited (code ${state.metroExit})`;
		return state.metroExit === 0 ? dim(exited) : red(exited);
	}
	switch (task.status) {
		case "pending":
			return dim("waiting");
		case "running":
			return spins(task, state) ? cyan(`running ${duration}`) : green(`live ${duration}`);
		case "ok":
			return green(`${SYMBOLS.ok} done ${duration}`);
		case "fail":
			return red(`${SYMBOLS.fail} failed ${duration}`);
	}
}

/** The pane's first row: which task the log belongs to, its state, and where the log is scrolled to. */
function paneTitle(task: Task | undefined, state: TuiState, width: number): string {
	if (!task) return " ".repeat(width);
	const interacting = state.mode === "interact" && task.id === "metro";
	const mode = interacting ? ` ${dim("·")} ${cyan("interact · esc to leave")}` : "";
	const left = ` ${bold(task.title)} ${dim("·")} ${statusText(task, state)}${mode}`;
	const scrolled = task.scroll > 0 ? dim(`↑${task.scroll} `) : "";
	const room = width - visibleWidth(scrolled);
	return fit(`${fit(left, room)}${scrolled}`, width);
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
	return { x: Math.min(cols - 1, listWidth(cols) + 2 + cursor.x), y: 2 + cursor.y };
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
	const metro = state.metroExit === undefined ? "" : `metro exited (${state.metroExit})`;
	const badge = metro && state.metroExit !== 0 ? red(`${SYMBOLS.fail} ${metro}`) : dim(metro);
	const hudBadge = cols >= HUD_MIN_COLS ? dim(`hud ${state.hud.visible ? "on" : "off"}`) : "";
	const hud = [badge, hudBadge].filter((part) => part !== "").join("  ");
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

/** The last action's outcome while it is fresh, else undefined. */
function flashText(state: TuiState): string | undefined {
	const { flash } = state;
	if (!flash || state.now - flash.at >= FLASH_MS) return undefined;
	return flash.kind === "ok" ? `${green(SYMBOLS.ok)} ${flash.text}` : `${red(SYMBOLS.fail)} ${red(flash.text)}`;
}

function footer(state: TuiState, cols: number): string {
	if (state.quitting) return fit(dim("stopping… waiting for Metro and the device to release"), cols);
	if (state.mode === "prompt" && state.prompt)
		return fit(
			`${bold(`${state.prompt.label}:`)} ${state.prompt.text}${cyan("▏")}  ${dim(footerHint("prompt"))}`,
			cols
		);
	const flash = state.mode === "list" || state.mode === "log" ? flashText(state) : undefined;
	const room = flash ? cols - visibleWidth(flash) - 2 : cols;
	const hint = dim(footerHint(state.mode, room));
	return fit(flash ? `${flash}  ${hint}` : hint, cols);
}

type HelpSection = { title: string; entries: string[] };

const entry = (label: string, desc: string): string => `${label.padEnd(8)} ${desc}`;

function section(group: KeyGroup): HelpSection {
	const inGroup = (b: Binding): boolean => !b.hidden && b.group === group;
	return { title: KEY_GROUP_TITLES[group], entries: LIST_BINDINGS.filter(inGroup).map((b) => entry(b.label, b.desc)) };
}

/** A column of sections: bold titles, their keys, a blank row between sections. */
function column(sections: HelpSection[]): string[] {
	return sections.flatMap((s, i) => [...(i > 0 ? [""] : []), bold(s.title), ...s.entries]);
}

function helpBox(cols: number, bodyHeight: number): { rows: string[]; x: number; y: number } {
	const boxWidth = Math.min(cols - 2, 96);
	const inner = boxWidth - 2;
	const gap = 2;
	const colWidth = Math.floor((inner - 2 - gap * 2) / 3);
	const expo: HelpSection = { title: "Expo · interact mode", entries: EXPO_KEYS.map((k) => entry(k.label, k.desc)) };
	const columns = [
		column([section("navigate"), section("perf")]),
		column([section("app"), section("metro")]),
		column([expo]),
	];
	const lineCount = Math.max(...columns.map((c) => c.length));
	const cell = (text: string | undefined): string => fit(text ?? "", colWidth);
	const body = Array.from({ length: lineCount }, (_, i) =>
		fit(` ${columns.map((c) => cell(c[i])).join(" ".repeat(gap))}`, inner)
	);
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
	const logHeight = bodyHeight - 1;
	const log = metroPaneRows(selectedTask, state, pane, logHeight) ?? logWindow(selectedTask, right - 1, logHeight);
	const divider = state.mode === "log" || state.mode === "interact" ? cyan("│") : dim("│");
	let body = Array.from({ length: bodyHeight }, (_, y) => {
		const task = state.tasks[y];
		const listCell = task ? taskRow(task, y === state.selected, state, left) : " ".repeat(left);
		const paneCell = y === 0 ? paneTitle(selectedTask, state, right) : fit(` ${log[y - 1] ?? ""}`, right);
		return `${listCell}${divider}${paneCell}`;
	});
	const hudBox = hudLines(state, cols);
	if (hudBox) {
		const x = cols - HUD_WIDTH;
		body = body.map((line, y) => {
			const boxRow = y === 0 ? undefined : hudBox[y - 1];
			return boxRow === undefined ? line : `${sliceColumns(line, 0, x)}${boxRow}`;
		});
	}
	if (state.mode === "help") {
		const box = helpBox(cols, bodyHeight);
		body = body.map((line, y) => {
			const boxRow = box.rows[y - box.y];
			if (boxRow === undefined) return line;
			const end = box.x + visibleWidth(boxRow);
			return `${sliceColumns(line, 0, box.x - 1)} ${boxRow} ${sliceColumns(line, end + 1, cols)}`;
		});
	}
	return [header(state, cols), ...body.map((line) => fit(line, cols)), footer(state, cols)];
}
