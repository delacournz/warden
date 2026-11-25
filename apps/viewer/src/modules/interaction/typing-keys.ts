import type { DeviceKey } from "./device-actions.ts";

/** Printable characters buffer this long before they are sent as one string. */
export const TYPING_BUFFER_MS = 25;

export type TypingKeySample = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
export type TypingAction =
	| { kind: "text"; text: string }
	| { kind: "key"; key: DeviceKey }
	| { kind: "paste" }
	| { kind: "exit" };

/** What a keydown means while typing mode is on; null for chords and keys the device ignores. */
export function classifyTypingKey(event: TypingKeySample): TypingAction | null {
	if (event.key === "Escape") return { kind: "exit" };
	if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "v") return { kind: "paste" };
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (event.key === "Backspace") return { kind: "key", key: "BACKSPACE" };
	if (event.key === "Enter") return { kind: "key", key: "ENTER" };
	if ([...event.key].length === 1) return { kind: "text", text: event.key };
	return null;
}
