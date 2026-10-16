import { escapeHtml } from "./escape";

/**
 * Pure SVG chart generators for the HTML report: no DOM, no clock, no randomness. Colours are never inlined;
 * each series gets a `s-<series>` class and the page CSS maps it to a palette token (so light/dark just works).
 * Every mark is labelled with text and carries a native `<title>` tooltip, so colour is never the only encoding.
 */

export const CHART_WIDTH = 520;
const PAD_LEFT = 8;
const PAD_RIGHT = 138;
const PAD_TOP = 6;
const AXIS_HEIGHT = 26;
const GROUP_HEADER = 22;
const GROUP_GAP = 14;

/** Rounds to 2 decimals so the markup is stable and compact. */
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** A linear scale from a data domain to a pixel range. A zero-width domain maps everything to the range start. */
export function linearScale(
	domain: readonly [number, number],
	range: readonly [number, number]
): (v: number) => number {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	if (d1 === d0) return () => r0;
	return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** The smallest of 1/2/2.5/5/10 x 10^k that is >= `raw`. */
function niceStep(raw: number): number {
	const exp = 10 ** Math.floor(Math.log10(raw));
	const frac = raw / exp;
	const pick = [1, 2, 2.5, 5, 10].find((m) => frac <= m + 1e-9) ?? 10;
	return pick * exp;
}

/** Tick values from 0 up to a clean maximum >= `max`, about `target` intervals. Always includes 0. */
export function niceTicks(max: number, target = 4): number[] {
	if (!Number.isFinite(max) || max <= 0) return [0, 1];
	const step = niceStep(max / target);
	const count = Math.ceil(max / step - 1e-9);
	return Array.from({ length: count + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

/** Compact duration axis label: `500 ms`, `1.5 s`, `20 s`. */
export function tickMs(v: number): string {
	if (v === 0) return "0";
	if (v < 1000) return `${v} ms`;
	return `${Math.round((v / 1000) * 100) / 100} s`;
}

export type BarDatum = {
	/** series key (a framework id); drives the colour class and the toggle attribute */
	series: string;
	value: number;
	/** text printed at the end of the bar (include the ratio) */
	label: string;
	/** draws a whisker from `value` to this x value (p95) */
	whiskerTo?: number;
	/** draws a marker at this x value (cold rep 1) */
	marker?: number;
	/** extra tooltip text */
	detail?: string;
	/** bold the label (fastest) */
	best?: boolean;
};
export type BarGroup = { label: string; bars: BarDatum[] };

export type BoxDatum = {
	series: string;
	min: number;
	median: number;
	p95: number;
	max: number;
	label: string;
	detail?: string;
};
export type BoxGroup = { label: string; boxes: BoxDatum[] };

type ChartMeta = {
	/** unique within the page; prefixes the aria ids */
	id: string;
	title: string;
	/** a text summary of the data for assistive tech */
	desc: string;
	tickLabel: (v: number) => string;
};

const seriesClass = (series: string): string => `s-${series.replace(/[^a-z0-9-]/gi, "")}`;

type Frame = { x0: number; x1: number; ticks: number[]; scale: (v: number) => number; height: number; top: number };

/** The shared plot frame for a chart whose rows add up to `bodyHeight`. */
function frame(maxValue: number, bodyHeight: number): Frame {
	const ticks = niceTicks(maxValue);
	const x0 = PAD_LEFT;
	const x1 = CHART_WIDTH - PAD_RIGHT;
	const top = PAD_TOP;
	return {
		x0,
		x1,
		ticks,
		scale: linearScale([0, ticks[ticks.length - 1] ?? 1], [x0, x1]),
		top,
		height: top + bodyHeight + AXIS_HEIGHT,
	};
}

function gridMarkup(f: Frame, tickLabel: (v: number) => string, bodyHeight: number): string {
	const axisY = f.top + bodyHeight;
	const lines = f.ticks.map((t) => {
		const x = num(f.scale(t));
		return (
			`<line class="grid" x1="${x}" x2="${x}" y1="${f.top}" y2="${axisY}"/>` +
			`<text class="tick" x="${x}" y="${axisY + 16}" text-anchor="middle">${escapeHtml(tickLabel(t))}</text>`
		);
	});
	return `<g class="axis">${lines.join("")}</g>`;
}

/** A bar whose data end (right) is rounded by `r` and whose baseline end (left) is square. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
	const width = Math.max(w, 1);
	const rr = Math.min(r, width, h / 2);
	return [
		`M${num(x)} ${num(y)}`,
		`h${num(width - rr)}`,
		`a${num(rr)} ${num(rr)} 0 0 1 ${num(rr)} ${num(rr)}`,
		`v${num(h - 2 * rr)}`,
		`a${num(rr)} ${num(rr)} 0 0 1 ${num(-rr)} ${num(rr)}`,
		`h${num(-(width - rr))}`,
		"z",
	].join(" ");
}

function wrapSvg(meta: ChartMeta, height: number, body: string): string {
	return (
		`<svg class="chart" viewBox="0 0 ${CHART_WIDTH} ${num(height)}" role="img" ` +
		`aria-labelledby="${escapeHtml(meta.id)}-t ${escapeHtml(meta.id)}-d">` +
		`<title id="${escapeHtml(meta.id)}-t">${escapeHtml(meta.title)}</title>` +
		`<desc id="${escapeHtml(meta.id)}-d">${escapeHtml(meta.desc)}</desc>${body}</svg>`
	);
}

const BAR_H = 14;
const BAR_STEP = 18;

function barMarkup(b: BarDatum, f: Frame, y: number): string {
	const cy = y + BAR_H / 2;
	const end = Math.max(b.value, b.whiskerTo ?? 0, b.marker ?? 0);
	const parts = [
		`<title>${escapeHtml(`${b.series}: ${b.label}${b.detail ? ` (${b.detail})` : ""}`)}</title>`,
		`<path class="mark" d="${barPath(f.x0, y, f.scale(b.value) - f.x0, BAR_H)}"/>`,
	];
	if (b.whiskerTo !== undefined && b.whiskerTo > b.value) {
		const a = num(f.scale(b.value));
		const z = num(f.scale(b.whiskerTo));
		parts.push(
			`<line class="whisker" x1="${a}" x2="${z}" y1="${num(cy)}" y2="${num(cy)}"/>`,
			`<line class="whisker" x1="${z}" x2="${z}" y1="${num(cy - 4)}" y2="${num(cy + 4)}"/>`
		);
	}
	if (b.marker !== undefined)
		parts.push(`<circle class="marker" cx="${num(f.scale(b.marker))}" cy="${num(cy)}" r="4.5"/>`);
	parts.push(
		`<text class="val${b.best ? " best" : ""}" x="${num(f.scale(end) + 8)}" y="${num(cy + 4)}">${escapeHtml(b.label)}</text>`
	);
	return `<g class="bar ${seriesClass(b.series)}" data-fw="${escapeHtml(b.series)}">${parts.join("")}</g>`;
}

/**
 * Grouped horizontal bars on one shared 0-based axis (never dual-axis). Group headers sit above their bars so
 * the plot uses the full width on a phone. Optional p95 whisker and a cold marker per bar.
 */
export function barChart(meta: ChartMeta & { groups: readonly BarGroup[] }): string {
	const groups = meta.groups.filter((g) => g.bars.length > 0);
	const maxValue = Math.max(
		0,
		...groups.flatMap((g) => g.bars.map((b) => Math.max(b.value, b.whiskerTo ?? 0, b.marker ?? 0)))
	);
	const rowsHeight = groups.reduce((sum, g) => sum + GROUP_HEADER + g.bars.length * BAR_STEP + GROUP_GAP, 0);
	const f = frame(maxValue, rowsHeight);
	let y = f.top;
	const body = groups.map((g) => {
		const header = `<text class="group" x="${f.x0}" y="${num(y + 14)}">${escapeHtml(g.label)}</text>`;
		const bars = g.bars.map((b, i) => barMarkup(b, f, y + GROUP_HEADER + i * BAR_STEP)).join("");
		y += GROUP_HEADER + g.bars.length * BAR_STEP + GROUP_GAP;
		return `<g class="grp">${header}${bars}</g>`;
	});
	return wrapSvg(meta, f.height, gridMarkup(f, meta.tickLabel, rowsHeight) + body.join(""));
}

const BOX_H = 10;
const BOX_STEP = 16;

function boxMarkup(b: BoxDatum, f: Frame, y: number): string {
	const cy = y + BOX_H / 2;
	const x = (v: number) => num(f.scale(v));
	const boxW = Math.max(f.scale(b.p95) - f.scale(b.min), 1);
	const parts = [
		`<title>${escapeHtml(`${b.series}: ${b.label}${b.detail ? ` (${b.detail})` : ""}`)}</title>`,
		`<line class="whisker" x1="${x(b.min)}" x2="${x(b.max)}" y1="${num(cy)}" y2="${num(cy)}"/>`,
		`<line class="whisker" x1="${x(b.max)}" x2="${x(b.max)}" y1="${num(cy - 4)}" y2="${num(cy + 4)}"/>`,
		`<rect class="box" x="${x(b.min)}" y="${num(y)}" width="${num(boxW)}" height="${BOX_H}" rx="2"/>`,
		`<line class="median" x1="${x(b.median)}" x2="${x(b.median)}" y1="${num(y - 2)}" y2="${num(y + BOX_H + 2)}"/>`,
		`<text class="val" x="${num(f.scale(b.max) + 8)}" y="${num(cy + 4)}">${escapeHtml(b.label)}</text>`,
	];
	return `<g class="boxrow ${seriesClass(b.series)}" data-fw="${escapeHtml(b.series)}">${parts.join("")}</g>`;
}

/**
 * Box/whisker rows from a Dist: whisker min..max, box min..p95, median tick. A Dist carries no quartiles, so the
 * box is deliberately min..p95 rather than the textbook interquartile range; the legend note says so.
 */
export function boxChart(meta: ChartMeta & { groups: readonly BoxGroup[] }): string {
	const groups = meta.groups.filter((g) => g.boxes.length > 0);
	const maxValue = Math.max(0, ...groups.flatMap((g) => g.boxes.map((b) => b.max)));
	const rowsHeight = groups.reduce((sum, g) => sum + GROUP_HEADER + g.boxes.length * BOX_STEP + GROUP_GAP, 0);
	const f = frame(maxValue, rowsHeight);
	let y = f.top;
	const body = groups.map((g) => {
		const header = `<text class="group" x="${f.x0}" y="${num(y + 14)}">${escapeHtml(g.label)}</text>`;
		const rows = g.boxes.map((b, i) => boxMarkup(b, f, y + GROUP_HEADER + 2 + i * BOX_STEP)).join("");
		y += GROUP_HEADER + g.boxes.length * BOX_STEP + GROUP_GAP;
		return `<g class="grp">${header}${rows}</g>`;
	});
	return wrapSvg(meta, f.height, gridMarkup(f, meta.tickLabel, rowsHeight) + body.join(""));
}
