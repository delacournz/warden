import type { Rect } from "../driver/driver.types";
import type { QueryRole } from "../screen/roles";
import { type NewStep, type Recording, recordingSchema, type Target } from "./recording.schema";

/** Fixtures shared by the authoring tests: terse target builders and a recording that uses every step kind. */

export const SAMPLE_FRAME: Rect = { x: 24, y: 300, width: 342, height: 48 };

/** A selector target whose chain is `selector` then the path; the landmark is where `frame` says. */
export function selectorTarget(
	selector: string,
	role: QueryRole,
	options: { frame?: Rect; label?: string; path?: string; by?: "id" | "role-label" | "role-text" } = {}
): Target {
	const by = options.by ?? (selector.startsWith("id=") ? "id" : "role-label");
	return {
		kind: "selector",
		selector,
		chain: [
			{ by, selector },
			{ by: "path", path: options.path ?? "0", role },
		],
		landmark: {
			role,
			frame: options.frame ?? SAMPLE_FRAME,
			...(options.label !== undefined && { label: options.label }),
		},
	};
}

export function recordingOf(steps: readonly NewStep[], overrides: Partial<Recording> = {}): Recording {
	return recordingSchema.parse({
		v: 1,
		name: "sign in",
		createdAt: 1_700_000_000_000,
		recordedOn: { platform: "ios", device: "iPhone 16", screen: { width: 390, height: 844, scale: 3 } },
		...overrides,
		steps: steps.map((step, i) => ({ ...step, i })),
	});
}

const target = (selector: string, role: QueryRole, label?: string): Target =>
	selectorTarget(selector, role, label === undefined ? {} : { label });

/** One step of every kind, plus the target spellings export has to tell apart. */
export function allStepsRecording(): Recording {
	let at = 1_700_000_000_000;
	const tick = (): number => {
		at += 250;
		return at;
	};
	const steps: NewStep[] = [
		{
			kind: "open",
			at: tick(),
			app: "nz.co.delacour.warden.example",
			metro: "http://localhost:8081",
			args: ["--demo"],
			url: "warden-example://home",
		},
		{ kind: "open", at: tick(), url: "https://example.com/invite", note: "link from outside the app" },
		{
			kind: "press",
			at: tick(),
			target: target("id=sign-in-submit", "button", "Sign in"),
			settle: {},
			snapshotHash: "a1",
		},
		{ kind: "fill", at: tick(), target: target("id=email", "textbox"), text: "chris@example.com" },
		{ kind: "fill", at: tick(), target: target("id=password", "textbox"), text: { secret: "PASSWORD" } },
		{ kind: "type", at: tick(), target: target("id=notes", "textbox"), text: "hello" },
		{ kind: "key", at: tick(), target: target("id=notes", "textbox"), key: "Enter" },
		{ kind: "key", at: tick(), target: target("id=notes", "textbox"), key: "Tab", modifiers: ["shift"] },
		{
			kind: "gesture",
			type: "longpress",
			at: tick(),
			target: target("label=Row role=button", "button", "Row"),
			durationMs: 800,
		},
		{
			kind: "gesture",
			type: "swipe",
			at: tick(),
			by: "direction",
			direction: "down",
			target: target("id=list", "other"),
			momentum: "fast",
		},
		{ kind: "gesture", type: "swipe", at: tick(), by: "direction", direction: "left" },
		{
			kind: "gesture",
			type: "swipe",
			at: tick(),
			by: "path",
			from: { x: 200, y: 600 },
			to: { x: 200, y: 200 },
			durationMs: 400,
		},
		{ kind: "gesture", type: "pinch", at: tick(), scale: 2, target: target("id=map", "other"), durationMs: 700 },
		{ kind: "gesture", type: "pinch", at: tick(), scale: 0.5 },
		{
			kind: "gesture",
			type: "pinch",
			at: tick(),
			scale: 3,
			target: { kind: "coords", x: 150, y: 250, warning: "recorded by coordinates" },
			radius: 80,
		},
		{ kind: "gesture", type: "rotate", at: tick(), degrees: 45, target: target("id=map", "other") },
		{ kind: "gesture", type: "rotate", at: tick(), degrees: -90, durationMs: 800, radius: 120 },
		{
			kind: "gesture",
			type: "path",
			at: tick(),
			paths: [
				[
					{ x: 100, y: 400 },
					{ x: 200, y: 300 },
					{ x: 300, y: 400 },
				],
			],
		},
		{
			kind: "gesture",
			type: "path",
			at: tick(),
			paths: [
				[
					{ x: 100, y: 400 },
					{ x: 150, y: 400 },
				],
				[
					{ x: 300, y: 400 },
					{ x: 250, y: 400 },
				],
			],
			durationMs: 450,
		},
		{
			kind: "scroll",
			at: tick(),
			direction: "down",
			until: target("label=Footer role=text", "text", "Footer"),
			maxSwipes: 5,
			timeoutMs: 20_000,
		},
		{ kind: "scroll", at: tick(), direction: "up" },
		{ kind: "wait", at: tick(), target: target("id=todos-screen", "other"), timeoutMs: 5000 },
		{ kind: "wait", at: tick(), target: target("id=spinner", "other"), state: "hidden" },
		{ kind: "wait", at: tick(), target: target("text=Done", "text", "Done"), state: "attached" },
		{ kind: "wait", at: tick(), target: target("text=Gone", "text", "Gone"), state: "detached", timeoutMs: 1000 },
		{ kind: "is", at: tick(), target: target("id=remember-me", "switch"), state: "checked" },
		{ kind: "is", at: tick(), target: target("id=remember-me", "switch"), state: "unchecked" },
		{ kind: "is", at: tick(), target: target("id=sign-in-submit", "button"), state: "enabled", not: true },
		{ kind: "is", at: tick(), target: target("id=sign-in-submit", "button"), state: "disabled" },
		{ kind: "is", at: tick(), target: target("id=banner", "other"), state: "visible" },
		{ kind: "is", at: tick(), target: target("id=banner", "other"), state: "hidden" },
		{ kind: "get", at: tick(), target: target("id=welcome-title", "text"), property: "text", expected: "Welcome back" },
		{
			kind: "get",
			at: tick(),
			target: target("id=email", "textbox"),
			property: "value",
			expected: "chris@example.com",
		},
		{ kind: "alert", at: tick(), action: "accept" },
		{ kind: "alert", at: tick(), action: "dismiss" },
		{ kind: "alert", at: tick(), action: { button: "Allow While Using App" } },
		{ kind: "note", at: tick(), text: "Leave the app and come back" },
		{ kind: "home", at: tick() },
		{ kind: "back", at: tick() },
		{ kind: "reload", at: tick() },
		{ kind: "use", at: tick(), module: "./helper-module", fn: "signIn" },
		{ kind: "screen", type: "rotate", at: tick(), orientation: "landscapeLeft" },
		{ kind: "screen", type: "appearance", at: tick(), mode: "dark" },
		{ kind: "snapshot", at: tick(), interactiveOnly: true },
		{ kind: "screen", type: "screenshot", at: tick(), name: "after-login" },
		{ kind: "screen", type: "screenshot", at: tick() },
		{ kind: "press", at: tick(), target: target("role=switch nth=1", "switch") },
		{ kind: "press", at: tick(), target: target("label=Settings", "other", "Settings") },
		{ kind: "press", at: tick(), target: target("label=Profile role=tab", "tab", "Profile") },
		{ kind: "press", at: tick(), target: target("value=/^\\d+$/", "textbox") },
		{ kind: "press", at: tick(), target: { kind: "coords", x: 120, y: 340, warning: "recorded by coordinates" } },
		{
			kind: "gesture",
			type: "longpress",
			at: tick(),
			target: { kind: "coords", x: 10, y: 20, warning: "recorded by coordinates" },
		},
		{ kind: "type", at: tick(), text: "typed with nothing focused by name" },
		{ kind: "key", at: tick(), key: "Escape" },
	];
	return recordingOf(steps, {
		recordedOn: {
			platform: "ios",
			device: "iPhone 16",
			screen: { width: 390, height: 844, scale: 3 },
			app: "nz.co.delacour.warden.example",
			metro: "http://localhost:8081",
		},
	});
}
