/** A showcase state tone, named for what it says. Each maps to one theme variable. */
export type Tone = "idle" | "scan" | "open" | "warn" | "off";

/** The theme variable behind each tone (`styles/app.css` for `--idle` / `--off`, `theme.css` for the rest). */
export const TONE_VARIABLE = {
	idle: "--idle",
	scan: "--info",
	open: "--success",
	warn: "--warning",
	off: "--off",
} as const satisfies Record<Tone, string>;

/** The classes for one event-log line: the dot and its text. `off` dims the dot only; its text stays readable. */
export const TONE_CLASSES = {
	idle: { dot: "bg-idle", text: "text-idle" },
	scan: { dot: "bg-info", text: "text-info" },
	open: { dot: "bg-success", text: "text-success" },
	warn: { dot: "bg-warning", text: "text-warning" },
	off: { dot: "bg-off", text: "text-muted-foreground" },
} as const satisfies Record<Tone, { dot: string; text: string }>;
