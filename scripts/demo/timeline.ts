import type { DemoDefinition, DemoStep, PlanStep, RecordedTake, RenderPlan, TerminalLayout } from "./demo.types";

export const CANVAS = { width: 1920, height: 1080, fps: 30 } as const;
export const PHONE = { x: 1289, y: 50, width: 451, height: 980, radius: 62 } as const;
/** Terminal body: first row y and usable height (px). */
export const TERMINAL_BODY = { top: 380, height: 500 } as const;
const MAX_PITCH = 86;
const MAX_FONT = 25;
const MIN_FONT = 17;
const MAX_TYPE_S = 0.75;
const TYPE_S_PER_CHAR = 0.024;
const OUTRO_DELAY_S = 0.8;

const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(token|secret|password|passwd|api[_-]?key|authorization|bearer)(\s*[:=]\s*|\s+)\S+/gi,
	/\b(?:sk|pk|ghp|gho|ghs|xox[abp]|eyJ)[A-Za-z0-9_.-]{16,}/g,
	/\b[A-Fa-f0-9]{32,}\b/g,
	/\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

/** Replaces anything secret-looking with bullets; applied to every printed line. */
export function maskSecrets(text: string): string {
	let out = text;
	out = out.replace(SECRET_PATTERNS[0] as RegExp, (_m, key: string, sep: string) => `${key}${sep}••••••••`);
	for (const re of SECRET_PATTERNS.slice(1)) out = out.replace(re, "••••••••");
	return out;
}

const SAFE_ARG = /^[\w@%+=:,./#-]+$/;

function quoteArg(arg: string): string {
	if (SAFE_ARG.test(arg)) return arg;
	return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The command line printed in the terminal. */
export function shownCommand(step: DemoStep): string {
	return maskSecrets(step.shown ?? `warden ${step.argv.map(quoteArg).join(" ")}`);
}

/**
 * Fits `count` entries (command + output line each) plus the outro row into the
 * terminal body. Shrinks pitch and font down to a floor, then scrolls instead.
 */
export function computeTerminalLayout(count: number, bodyHeight: number = TERMINAL_BODY.height): TerminalLayout {
	const outroRow = Math.floor(MAX_PITCH / 2);
	const pitch = count === 0 ? MAX_PITCH : Math.min(MAX_PITCH, Math.floor((bodyHeight - outroRow) / count));
	const fontPx = Math.min(MAX_FONT, Math.floor(pitch * 0.29));
	if (fontPx >= MIN_FONT || count === 0) {
		return {
			entryPitch: pitch,
			outputOffset: Math.round(pitch * 0.44),
			fontPx,
			visibleEntries: count,
			scroll: false,
		};
	}
	return {
		entryPitch: MAX_PITCH,
		outputOffset: Math.round(MAX_PITCH * 0.44),
		fontPx: MAX_FONT,
		visibleEntries: Math.max(1, Math.floor((bodyHeight - outroRow) / MAX_PITCH)),
		scroll: true,
	};
}

/** Seconds the command takes to type; it finishes exactly when the step fires. */
export function typeDuration(shown: string): number {
	return Math.min(MAX_TYPE_S, shown.length * TYPE_S_PER_CHAR);
}

/**
 * Joins a definition with the recorder's measured times. Output appears at the
 * step's END; typing ends at its start and never overlaps the previous output.
 */
/** Drawn under the phone unless a definition says otherwise. */
export const DEFAULT_PHONE_CAPTION = "real simulator · not an animation";

export function buildPlan(def: DemoDefinition, take: RecordedTake, videoS: number, fontsDir: string): RenderPlan {
	const byIndex = new Map(take.steps.map((s) => [s.index, s]));
	const steps: PlanStep[] = [];
	let prevOutputS = 0.2;
	def.steps.forEach((step, index) => {
		if (step.hidden) return;
		const rec = byIndex.get(index);
		if (!rec) throw new Error(`no recorded times for step ${index} of ${def.name}`);
		const shown = shownCommand(step);
		const fireS = rec.startS;
		const outputS = Math.max(rec.endS, fireS + 0.05);
		const typeStartS = Math.max(prevOutputS + 0.1, fireS - typeDuration(shown));
		steps.push({
			shown,
			output: { kind: step.output.kind, text: maskSecrets(step.output.text) },
			typeStartS: Math.min(typeStartS, fireS),
			fireS,
			outputS,
		});
		prevOutputS = outputS;
	});
	const outroS = prevOutputS + OUTRO_DELAY_S;
	const durationS = Math.max(videoS, outroS) + def.tailHoldMs / 1000;
	return {
		title: def.title,
		subtitle: def.subtitle,
		terminalTitle: def.terminalTitle,
		footer: def.footer,
		phoneCaption: maskSecrets(def.phoneCaption ?? DEFAULT_PHONE_CAPTION),
		steps,
		outro: maskSecrets(def.outro),
		outroS,
		durationS,
		fps: CANVAS.fps,
		layout: computeTerminalLayout(steps.length),
		fontsDir,
	};
}
