import type { A11yAuditResult, Announcement } from "@delacour/warden-e2e/a11y/a11y.types";
import { failing, formatIssues } from "@delacour/warden-e2e/a11y/audit";
import { readingOrder } from "@delacour/warden-e2e/a11y/order";
import { announce } from "@delacour/warden-e2e/a11y/speech";
import { auditSnapshot } from "@delacour/warden-e2e/device-a11y";
import { canReadA11yEvents } from "@delacour/warden-e2e/driver/a11y-events";
import { canReadA11y } from "@delacour/warden-e2e/driver/a11y-read";
import type { Driver, DriverError, Element, Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { canDriveScreenReader } from "@delacour/warden-e2e/driver/screen-reader";
import { indexSnapshot } from "@delacour/warden-e2e/screen/nodes";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type FocusStep, parseAuditFlags, parseCursor, parseFocusStep } from "./a11y-parse";
import { deviceInfo, recordOf } from "./conditions";
import type { UiDevice } from "./device";
import { driverUiError, type UiDeps } from "./driver";
import { type UiError, type UiSuccess, uiError } from "./output";
import { runUi, type UiOptionValues, type UiRunEnv } from "./run";
import { parseTextSizeArg } from "./settings-parse";
import { readLastSnapshot, readState } from "./state";
import { findInFresh, parseTarget, pickBySelector, resolveTarget } from "./target";

/** Flags of the read-side `warden ui a11y` verbs (`audit`, `order`, `speak`, `announcements`, `focus`, `spoken`). */
export type A11yVerbOptions = UiOptionValues & {
	rule?: string[];
	ignore?: string[];
	minSeverity?: string;
	native?: boolean;
	since?: string;
	textSize?: string;
};

export const A11Y_VERBS = ["audit", "order", "speak", "announcements", "focus", "spoken"] as const;
export type A11yVerb = (typeof A11Y_VERBS)[number];

export const isA11yVerb = (action: string): action is A11yVerb => (A11Y_VERBS as readonly string[]).includes(action);

const OPEN_WITH_A11Y = "warden ui open <bundle> --relaunch --a11y";
const TALKBACK_HINT =
	"TalkBack drives only on an Android emulator: `warden ui a11y set --screen-reader` turns it on (see references/a11y.md)";

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

const usage = (message: string, hint?: string): { success: false; error: UiError } => ({
	success: false,
	error: uiError("usage", message, hint === undefined ? {} : { hint }),
});

/** A driver failure as a `warden ui` error; `E_UNSUPPORTED` is `unsupported` (exit 1) with the way to make it work. */
function a11yDriverError(error: DriverError, hint: string): UiError {
	if (error.code === "E_UNSUPPORTED") return uiError("unsupported", `${error.code}: ${error.message}`, { hint });
	return driverUiError(error);
}

type A11yRead = {
	snapshot: Snapshot;
	/** `read`: the iOS injected library's facts are merged in · `missing`: iOS app launched without it · `native`: Android's snapshot has them */
	facts: "read" | "missing" | "native";
};

/** A snapshot with the screen-reader facts merged in where the platform needs a second read (iOS inject). */
async function readA11ySnapshot(driver: Driver): Promise<Result<A11yRead, UiError>> {
	const taken = await driver.snapshot();
	if (!taken.success) return fail(driverUiError(taken.error));
	if (!canReadA11y(driver)) return ok({ snapshot: taken.data, facts: "native" });
	const read = await driver.readA11y(taken.data);
	if (read.success) return ok({ snapshot: read.data, facts: "read" });
	if (read.error.code === "E_UNSUPPORTED") return ok({ snapshot: taken.data, facts: "missing" });
	return fail(driverUiError(read.error));
}

const MISSING_FACTS = `hint, actions and iOS reading order not read: the app was launched without the injected library (\`${OPEN_WITH_A11Y}\`)`;

const factWarnings = (read: A11yRead): string[] => (read.facts === "missing" ? [MISSING_FACTS] : []);

// ---------- audit ----------

function auditText(result: A11yAuditResult, failed: number, minSeverity: string): string {
	const verdict =
		failed === 0 ? `ok: no issues at or above ${minSeverity}` : `FAIL: ${failed} at or above ${minSeverity}`;
	return `${formatIssues(result, "warning")}\n${verdict}`;
}

/**
 * `warden ui a11y audit [--rule <id>]… [--ignore <rule[:identifier]>]… [--min-severity error|warning] [--no-native]
 * [--text-size <size>]`: warden's rules over the screen, plus the platform's own audit (XCUITest on iOS, ATF on
 * Android) unless `--no-native`. Exit 1 (the result still prints) when an issue is at or above `--min-severity`
 * (default `error`); a native engine that cannot run is a `skipped` line, never a failure.
 */
async function audit(
	ctx: CommandContext,
	device: UiDevice,
	env: UiRunEnv,
	opts: A11yVerbOptions
): Promise<Result<UiSuccess, UiError>> {
	const flags = parseAuditFlags(opts);
	if (!flags.success) return usage(flags.error);
	const size = opts.textSize === undefined ? undefined : parseTextSizeArg(opts.textSize);
	if (size !== undefined && !size.success) return usage(size.error);
	const textSize = size?.success ? size.data : recordOf(ctx, device.lease.id, "a11y")?.value.textSize;
	const driver = await env.driver();
	if (!driver.success) return driver;
	const read = await readA11ySnapshot(driver.data);
	if (!read.success) return read;
	const bundleId = readState(ctx, device.udid).app;
	const result = await auditSnapshot(driver.data, read.data.snapshot, {
		...(flags.data.rules === undefined ? {} : { rules: flags.data.rules }),
		ignore: flags.data.ignore,
		minSeverity: flags.data.minSeverity,
		...(textSize === undefined ? {} : { textSize }),
		...(opts.native === false ? { native: false } : {}),
		...(bundleId === undefined ? {} : { bundleId }),
	});
	const bad = failing(result, flags.data.minSeverity);
	const warnings = [...factWarnings(read.data), ...result.skipped.map((s) => `${s.source} audit skipped: ${s.reason}`)];
	return ok({
		device: deviceInfo(device),
		result: {
			action: "a11y-audit",
			passed: bad.length === 0,
			minSeverity: flags.data.minSeverity,
			failing: bad.length,
			checked: result.checked,
			sources: result.sources,
			skipped: result.skipped,
			issues: result.issues,
		},
		text: auditText(result, bad.length, flags.data.minSeverity),
		...(warnings.length > 0 ? { warnings } : {}),
		...(bad.length > 0 ? { exit: 1 as const } : {}),
	});
}

// ---------- order / speak ----------

const stop = (a: Announcement, n: number): string => `${String(n).padStart(2)}  ${a.text}`;

/** `warden ui a11y order`: the SIMULATED reading order of the screen, one stop per line. */
async function order(device: UiDevice, env: UiRunEnv): Promise<Result<UiSuccess, UiError>> {
	const driver = await env.driver();
	if (!driver.success) return driver;
	const read = await readA11ySnapshot(driver.data);
	if (!read.success) return read;
	const stops = readingOrder(read.data.snapshot, device.platform);
	const warnings = factWarnings(read.data);
	return ok({
		device: deviceInfo(device),
		result: { action: "a11y-order", simulated: true, count: stops.length, order: stops },
		text: [
			`reading order (simulated, ${stops.length} stops; not what ${device.platform === "ios" ? "VoiceOver" : "TalkBack"} says)`,
			...stops.map((a, i) => stop(a, i + 1)),
		].join("\n"),
		...(warnings.length > 0 ? { warnings } : {}),
	});
}

/** The element a locator (`@eN`, `id=… label=…`) names, taken from a snapshot that carries the a11y facts. */
async function locate(
	ctx: CommandContext,
	device: UiDevice,
	driver: Driver,
	words: readonly string[]
): Promise<Result<{ element: Element; read: A11yRead }, UiError>> {
	const target = parseTarget(words.join(" "));
	if (!target.success) return target;
	if (target.data.kind === "point") return usage("a11y speak takes a locator (@eN or a selector), not coordinates");
	if (target.data.kind === "ref") {
		const resolved = await resolveTarget(target.data, {
			lastSnapshot: readLastSnapshot(ctx, device.udid),
			now: ctx.now(),
			verify: false,
			driver,
		});
		if (!resolved.success) return resolved;
		const wanted = resolved.data.element;
		const read = await readA11ySnapshot(driver);
		if (!read.success) return read;
		const fresh = indexSnapshot(read.data.snapshot);
		const was = resolved.data.snapshot ? indexSnapshot(resolved.data.snapshot).byId.get(wanted?.id ?? "") : undefined;
		const now = was ? findInFresh(was, fresh) : undefined;
		const element = now?.element ?? wanted;
		return element === undefined
			? fail(uiError("stale_ref", `${target.data.ref} is no longer on screen`))
			: ok({ element, read: read.data });
	}
	const read = await readA11ySnapshot(driver);
	if (!read.success) return read;
	const picked = pickBySelector(indexSnapshot(read.data.snapshot), target.data.selector);
	return picked.success ? ok({ element: picked.data.element, read: read.data }) : picked;
}

/** `warden ui a11y speak <locator>`: what the screen reader would say for one element (SIMULATED). */
async function speak(
	ctx: CommandContext,
	device: UiDevice,
	env: UiRunEnv,
	words: readonly string[]
): Promise<Result<UiSuccess, UiError>> {
	if (words.length === 0) return usage("a11y speak needs a locator", "@eN | id=… label=… text=… role=…");
	const driver = await env.driver();
	if (!driver.success) return driver;
	const found = await locate(ctx, device, driver.data, words);
	if (!found.success) return found;
	const said = announce(found.data.element, device.platform);
	const warnings = factWarnings(found.data.read);
	return ok({
		device: deviceInfo(device),
		result: { action: "a11y-speak", simulated: true, announcement: said },
		text: `${said.text}  (simulated)`,
		...(warnings.length > 0 ? { warnings } : {}),
	});
}

// ---------- announcements / spoken / focus ----------

/** `warden ui a11y announcements [--since <cursor>]`: announcements and live-region changes, oldest first. */
async function announcements(
	device: UiDevice,
	env: UiRunEnv,
	opts: A11yVerbOptions
): Promise<Result<UiSuccess, UiError>> {
	const since = parseCursor(opts.since);
	if (!since.success) return usage(since.error);
	const driver = await env.driver();
	if (!driver.success) return driver;
	if (!canReadA11yEvents(driver.data)) {
		return fail(uiError("unsupported", "this driver cannot read announcements (no a11yEvents capability)"));
	}
	const read = await driver.data.a11yEvents(since.data);
	if (!read.success) {
		return fail(a11yDriverError(read.error, `launch the app with the injected library first: \`${OPEN_WITH_A11Y}\``));
	}
	const said = read.data.events.flatMap((e) =>
		(e.kind === "announcement" || e.kind === "live-region") && e.text !== undefined
			? [{ kind: e.kind, text: e.text, at: e.at, source: e.source }]
			: []
	);
	return ok({
		device: deviceInfo(device),
		result: {
			action: "a11y-announcements",
			announcements: said,
			cursor: read.data.cursor,
			...(read.data.lost ? { lost: true } : {}),
		},
		text: [...said.map((a) => `${a.kind}  ${JSON.stringify(a.text)}`), `cursor ${read.data.cursor}`].join("\n"),
		...(read.data.lost ? { warnings: ["the event buffer overwrote announcements you had not read"] } : {}),
	});
}

/** `warden ui a11y spoken [--since <cursor>]`: what TalkBack said, from its log when verbose else composed (simulated). */
async function spoken(device: UiDevice, env: UiRunEnv, opts: A11yVerbOptions): Promise<Result<UiSuccess, UiError>> {
	const since = parseCursor(opts.since);
	if (!since.success) return usage(since.error);
	const driver = await env.driver();
	if (!driver.success) return driver;
	if (!canDriveScreenReader(driver.data))
		return fail(uiError("unsupported", "no real screen reader on this device", { hint: TALKBACK_HINT }));
	const read = await driver.data.screenReaderSpoken(since.data);
	if (!read.success) return fail(a11yDriverError(read.error, TALKBACK_HINT));
	return ok({
		device: deviceInfo(device),
		result: { action: "a11y-spoken", lines: read.data.lines, cursor: read.data.cursor },
		text: [...read.data.lines.map((l) => `${l.text}  (${l.source})`), `cursor ${read.data.cursor}`].join("\n"),
	});
}

function focusText(step: FocusStep, said: Announcement | undefined): string {
	if (said !== undefined) return `${said.text}  (simulated)`;
	return step === "status" ? "no element holds screen-reader focus" : "end of screen (no further element)";
}

/** `warden ui a11y focus next|prev|activate|status`: TalkBack's accessibility focus, driven like a user's swipes. */
async function focus(device: UiDevice, env: UiRunEnv, words: readonly string[]): Promise<Result<UiSuccess, UiError>> {
	const step = parseFocusStep(words[0]);
	if (!step.success) return usage(step.error, "next | prev | activate | status");
	const driver = await env.driver();
	if (!driver.success) return driver;
	const reader = driver.data;
	if (!canDriveScreenReader(reader))
		return fail(uiError("unsupported", "no real screen reader on this device", { hint: TALKBACK_HINT }));
	const info = deviceInfo(device);
	if (step.data === "activate") {
		const done = await reader.screenReaderActivate();
		if (!done.success) return fail(a11yDriverError(done.error, TALKBACK_HINT));
		return ok({
			device: info,
			result: { action: "a11y-focus", step: "activate", activated: true },
			text: "activated the focused element",
		});
	}
	const moved =
		step.data === "next"
			? await reader.screenReaderNext()
			: step.data === "prev"
				? await reader.screenReaderPrev()
				: await reader.screenReaderFocused();
	if (!moved.success) return fail(a11yDriverError(moved.error, TALKBACK_HINT));
	const said = moved.data === undefined ? undefined : announce(moved.data, device.platform);
	if (step.data !== "status") {
		return ok({
			device: info,
			result: { action: "a11y-focus", step: step.data, focused: said ?? null },
			text: focusText(step.data, said),
		});
	}
	const state = await reader.screenReaderState();
	if (!state.success) return fail(a11yDriverError(state.error, TALKBACK_HINT));
	return ok({
		device: info,
		result: { action: "a11y-focus", step: "status", screenReader: state.data, focused: said ?? null },
		text: `screen reader ${state.data.mode === "off" ? "off" : `${state.data.mode} (${state.data.engine})`}\n${focusText("status", said)}`,
	});
}

/** The read-side verbs of `warden ui a11y …`. `set`, `reset` and `status` are `settings.ts`'s. */
export function uiA11yVerb(
	ctx: CommandContext,
	deps: UiDeps,
	verb: A11yVerb,
	rest: readonly string[],
	opts: A11yVerbOptions
): Promise<number> {
	const command = verb === "focus" ? `a11y focus ${rest[0] ?? ""}`.trim() : `a11y ${verb}`;
	return runUi(ctx, deps, command, opts, async (device, env) => {
		switch (verb) {
			case "audit":
				return audit(ctx, device, env, opts);
			case "order":
				return order(device, env);
			case "speak":
				return speak(ctx, device, env, rest);
			case "announcements":
				return announcements(device, env, opts);
			case "spoken":
				return spoken(device, env, opts);
			case "focus":
				return focus(device, env, rest);
		}
	});
}
