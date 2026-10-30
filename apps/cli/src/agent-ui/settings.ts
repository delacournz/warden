import { clearCondition, recordCondition } from "@delacour/warden-core/conditions/conditions";
import type {
	A11yCondition,
	BatteryCondition,
	ConditionRecord,
	ConditionValues,
	LocaleCondition,
	PermissionCondition,
	PermissionName,
	PermissionState,
} from "@delacour/warden-core/conditions/conditions.types";
import { appliedA11y, resolveTextSize } from "@delacour/warden-core/conditions/text-size";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { A11yVerbOptions } from "./a11y";
import { deviceInfo, fail, recordOf, resolveDeps, withPort } from "./conditions";
import type { ConditionsDeps } from "./conditions-types";
import type { UiDevice } from "./device";
import { driverUiError, fromDriver, type UiDeps } from "./driver";
import type { UiError, UiSuccess } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { parseLevel, parsePermissionPairs, parsePushPayload, parseTextSizeArg } from "./settings-parse";
import { readState } from "./state";

/** Flags of the device-setting verbs that name an app. */
export type AppOptionValues = UiOptionValues & { app?: string };

export type A11yOptionValues = UiOptionValues & {
	textSize?: string;
	bold?: boolean;
	contrast?: string;
	reduceMotion?: boolean;
	screenReader?: boolean;
	reduceTransparency?: boolean;
	buttonShapes?: boolean;
	differentiateWithoutColor?: boolean;
	onOffLabels?: boolean;
	highContrastText?: boolean;
	colorInversion?: boolean;
};

export type BatteryOptionValues = UiOptionValues & { level?: string; charging?: boolean };

type Deps = Required<ConditionsDeps>;

/** `--app`, else the app `warden ui open` last launched on the device, else the driver's own default. */
function appOf(ctx: CommandContext, device: UiDevice, app: string | undefined): { bundleId?: string } {
	const bundleId = app ?? readState(ctx, device.udid).app;
	return bundleId === undefined ? {} : { bundleId };
}

function save<A extends keyof ConditionValues>(
	ctx: CommandContext,
	device: UiDevice,
	area: A,
	value: ConditionValues[A]
): Result<undefined, UiError> {
	const saved = recordCondition(ctx.store(), device.lease.id, area, value, ctx.now());
	return saved.success ? ok(undefined) : fail("failed", `could not record the ${area} condition: ${saved.error}`);
}

function forget(ctx: CommandContext, device: UiDevice, area: ConditionRecord["area"]): void {
	clearCondition(ctx.store(), device.lease.id, area);
}

const success = (
	device: UiDevice,
	action: string,
	text: string,
	result: Record<string, unknown>,
	warnings: readonly string[] = []
): Result<UiSuccess, UiError> =>
	ok({
		device: deviceInfo(device),
		result: { action, ...result },
		text,
		...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
	});

function unexpected(action: string, rest: readonly string[], verb: string): { success: false; error: UiError } {
	return fail("usage", `unexpected argument "${rest[0] ?? ""}" for ${verb} ${action}`);
}

// ---------- permission ----------

const grantText = (c: PermissionCondition | undefined): string =>
	c === undefined || c.grants.length === 0
		? "no permissions changed"
		: c.grants.map((g) => `${g.permission}=${g.state}`).join(" ");

/** The recorded grants with `fresh` replacing any earlier state of the same app + permission. */
function mergedGrants(
	record: PermissionCondition | undefined,
	bundleId: string,
	fresh: readonly { permission: PermissionName; state: PermissionState }[]
): PermissionCondition {
	const kept = (record?.grants ?? []).filter(
		(g) => !(g.bundleId === bundleId && fresh.some((f) => f.permission === g.permission))
	);
	return { grants: [...kept, ...fresh.map((f) => ({ bundleId, ...f }))] };
}

async function permissionSet(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	rest: readonly string[],
	opts: AppOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const grants = parsePermissionPairs(rest);
	if (!grants.success) return fail("usage", grants.error);
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const applied = fromDriver(await port.permissions(grants.data, appOf(ctx, device, opts.app)));
		if (!applied.success) return applied;
		const state = applied.data;
		const previous = recordOf(ctx, device.lease.id, "permission")?.value;
		const merged = mergedGrants(previous, state.bundleId, state.applied);
		const saved = save(ctx, device, "permission", merged);
		if (!saved.success) return saved;
		const warnings = state.skipped.map((s) => `${s.permission} not applied: ${s.reason}`);
		return success(
			device,
			"permission-set",
			`${state.bundleId}: ${state.applied.map((a) => `${a.permission}=${a.state}`).join(" ")}`,
			{ bundleId: state.bundleId, applied: state.applied, skipped: state.skipped },
			warnings
		);
	});
}

async function permissionReset(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	opts: AppOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const record = recordOf(ctx, device.lease.id, "permission");
	if (record === undefined || record.value.grants.length === 0) {
		return success(device, "permission-reset", "no permissions were changed", { changed: false });
	}
	const bundles = [...new Set(record.value.grants.map((g) => g.bundleId))].filter(
		(b) => opts.app === undefined || b === opts.app
	);
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		for (const bundleId of bundles) {
			const back: Partial<Record<PermissionName, PermissionState>> = {};
			for (const g of record.value.grants) if (g.bundleId === bundleId) back[g.permission] = "unset";
			const done = await port.permissions(back, { bundleId });
			// an app that does not declare the permission has nothing to reset
			if (!done.success && done.error.code !== "E_UNSUPPORTED")
				return { success: false, error: driverUiError(done.error) };
		}
		const rest = record.value.grants.filter((g) => !bundles.includes(g.bundleId));
		if (rest.length === 0) forget(ctx, device, "permission");
		else {
			const saved = save(ctx, device, "permission", { grants: rest });
			if (!saved.success) return saved;
		}
		return success(device, "permission-reset", `permissions reset for ${bundles.join(", ")}`, {
			changed: true,
			bundles,
		});
	});
}

/**
 * `warden ui permission set <name>=<granted|denied|unset>... [--app <bundle>]` · `reset [--app]` · `status`.
 * iOS: `simctl privacy` (terminates a running app); Android: `pm grant|revoke`. Set before `open`. Recorded on the lease.
 */
export function uiPermission(
	ctx: CommandContext,
	deps: UiDeps,
	action: string,
	rest: readonly string[],
	opts: AppOptionValues
): Promise<number> {
	return runUi(ctx, deps, `permission ${action}`, opts, async (device) => {
		const real = await resolveDeps(deps);
		switch (action) {
			case "set":
				return permissionSet(ctx, real, device, rest, opts);
			case "reset":
				return rest.length > 0 ? unexpected(action, rest, "permission") : permissionReset(ctx, real, device, opts);
			case "status": {
				const record = recordOf(ctx, device.lease.id, "permission");
				return success(device, "permission-status", `permissions  ${grantText(record?.value)}`, {
					grants: record?.value.grants ?? [],
				});
			}
			default:
				return fail("usage", `unknown permission action "${action}"`, "set, reset or status");
		}
	});
}

// ---------- timezone and locale ----------

const localeText = (c: LocaleCondition | undefined): string => {
	const parts = [
		c?.timezone === undefined ? undefined : `timezone ${c.timezone}`,
		c?.locale === undefined ? undefined : `locale ${c.locale}${c.bundleId === undefined ? "" : ` (${c.bundleId})`}`,
	].filter((p): p is string => p !== undefined);
	return parts.length === 0 ? "not changed" : parts.join(", ");
};

/** Store `value`, or forget the area when it holds nothing. */
function saveLocale(ctx: CommandContext, device: UiDevice, value: LocaleCondition): Result<undefined, UiError> {
	if (value.timezone === undefined && value.locale === undefined) {
		forget(ctx, device, "locale");
		return ok(undefined);
	}
	return save(ctx, device, "locale", value);
}

async function timezoneApply(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	arg: string
): Promise<Result<UiSuccess, UiError>> {
	const record = recordOf(ctx, device.lease.id, "locale")?.value ?? {};
	const resetting = arg === "reset";
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const applied = fromDriver(
			await port.timezone(
				resetting ? null : arg,
				record.previousTimezone ? { previous: record.previousTimezone } : undefined
			)
		);
		if (!applied.success) return applied;
		const { timezone: _drop, previousTimezone: before, ...rest } = record;
		const previousTimezone = before ?? applied.data.previous;
		const next: LocaleCondition = resetting
			? rest
			: { ...rest, timezone: arg, ...(previousTimezone === undefined ? {} : { previousTimezone }) };
		const saved = saveLocale(ctx, device, next);
		if (!saved.success) return saved;
		const staged = applied.data.appliesOnLaunch === true;
		return success(
			device,
			resetting ? "timezone-reset" : "timezone-set",
			resetting ? "timezone reset" : `timezone ${arg}${staged ? " (next launch)" : ""}`,
			{ timezone: resetting ? null : arg, staged, previous: applied.data.previous ?? null },
			staged ? ["staged: a simulator has no device timezone; the app launched next gets it (`open --relaunch`)"] : []
		);
	});
}

/** `warden ui timezone <tz|reset|status>`: Android `cmd alarm set-timezone` (device-wide, live); iOS staged for the next launch. */
export function uiTimezone(ctx: CommandContext, deps: UiDeps, arg: string, opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, `timezone ${arg === "status" ? "status" : "set"}`, opts, async (device) => {
		if (arg === "status") {
			const record = recordOf(ctx, device.lease.id, "locale")?.value;
			return success(device, "timezone-status", `timezone  ${record?.timezone ?? "not changed"}`, {
				timezone: record?.timezone ?? null,
			});
		}
		return timezoneApply(ctx, await resolveDeps(deps), device, arg);
	});
}

async function localeApply(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	arg: string,
	opts: AppOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const record = recordOf(ctx, device.lease.id, "locale")?.value ?? {};
	const resetting = arg === "reset";
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const applied = fromDriver(
			await port.locale(resetting ? null : arg, appOf(ctx, device, opts.app ?? record.bundleId))
		);
		if (!applied.success) return applied;
		const { locale: _drop, bundleId: _app, ...rest } = record;
		const bundleId = applied.data.bundleId;
		const next: LocaleCondition = resetting
			? rest
			: { ...rest, locale: arg, ...(bundleId === undefined ? {} : { bundleId }) };
		const saved = saveLocale(ctx, device, next);
		if (!saved.success) return saved;
		const staged = applied.data.appliesOnLaunch === true;
		return success(
			device,
			resetting ? "locale-reset" : "locale-set",
			resetting ? "locale reset" : `locale ${arg}${staged ? " (next launch)" : ""}`,
			{ locale: resetting ? null : arg, bundleId: bundleId ?? null, staged },
			staged ? ["staged: the app launched next gets it (`open --relaunch`)"] : []
		);
	});
}

/** `warden ui locale <tag|reset|status> [--app <bundle>]`: Android 13+ per-app locale (live); iOS staged for the next launch. */
export function uiLocale(ctx: CommandContext, deps: UiDeps, arg: string, opts: AppOptionValues): Promise<number> {
	return runUi(ctx, deps, `locale ${arg === "status" ? "status" : "set"}`, opts, async (device) => {
		if (arg === "status") {
			const record = recordOf(ctx, device.lease.id, "locale")?.value;
			return success(device, "locale-status", `locale  ${localeText(record)}`, {
				locale: record?.locale ?? null,
				timezone: record?.timezone ?? null,
			});
		}
		return localeApply(ctx, await resolveDeps(deps), device, arg, opts);
	});
}

// ---------- a11y ----------

/** The on/off display settings beyond text size, bold, contrast and reduce motion. */
const A11Y_SWITCHES = [
	"screenReader",
	"reduceTransparency",
	"buttonShapes",
	"differentiateWithoutColor",
	"onOffLabels",
	"highContrastText",
	"colorInversion",
] as const satisfies readonly (keyof A11yOptionValues & keyof A11yCondition)[];

function a11yOpOf(opts: A11yOptionValues): Result<NonNullable<A11yCondition>, UiError> {
	const op: A11yCondition = {};
	if (opts.textSize !== undefined) {
		const size = parseTextSizeArg(opts.textSize);
		if (!size.success) return fail("usage", size.error);
		op.textSize = size.data;
	}
	if (opts.bold !== undefined) op.boldText = opts.bold;
	if (opts.reduceMotion !== undefined) op.reduceMotion = opts.reduceMotion;
	for (const key of A11Y_SWITCHES) if (opts[key] !== undefined) op[key] = opts[key];
	if (opts.contrast !== undefined) {
		if (opts.contrast !== "increased" && opts.contrast !== "normal") {
			return fail("usage", `--contrast must be increased or normal, got "${opts.contrast}"`);
		}
		op.contrast = opts.contrast;
	}
	return Object.keys(op).length === 0
		? fail(
				"usage",
				"a11y set needs one of --text-size, --bold, --contrast, --reduce-motion, --screen-reader, --reduce-transparency, --button-shapes, --differentiate-without-color, --on-off-labels, --high-contrast-text, --color-inversion"
			)
		: ok(op);
}

/**
 * Android TalkBack: keep the services and master switch the device had before warden turned it on (undo puts back
 * exactly those); once TalkBack is turned off again nothing of it stays on the record.
 */
function withScreenReaderRecord(
	record: A11yCondition,
	op: NonNullable<A11yCondition>,
	previous: A11yCondition["screenReaderPrevious"]
): A11yCondition {
	if (op.screenReader === false && record.screenReaderPrevious !== undefined) {
		const { screenReader: _off, screenReaderPrevious: _prior, ...rest } = record;
		return rest;
	}
	return previous === undefined ? record : { ...record, screenReaderPrevious: previous };
}

async function a11ySet(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	opts: A11yOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const op = a11yOpOf(opts);
	if (!op.success) return op;
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const applied = fromDriver(await port.a11y(op.data));
		if (!applied.success) return applied;
		const resolved = op.data.textSize === undefined ? undefined : resolveTextSize(op.data.textSize);
		const previous = recordOf(ctx, device.lease.id, "a11y")?.value ?? {};
		const next = withScreenReaderRecord(
			{
				...previous,
				...appliedA11y(op.data, applied.data.applied),
				...(resolved?.success ? { fontScale: resolved.data.scale } : {}),
			},
			op.data,
			applied.data.screenReaderPrevious
		);
		const saved = save(ctx, device, "a11y", next);
		if (!saved.success) return saved;
		const warnings = [
			...applied.data.skipped.map((s) => `${s.setting} not applied: ${s.reason}`),
			...applied.data.notes,
		];
		return success(
			device,
			"a11y-set",
			`a11y ${applied.data.applied.join(", ")}`,
			{
				applied: applied.data.applied,
				skipped: applied.data.skipped,
				...(applied.data.screenReader === undefined ? {} : { screenReader: applied.data.screenReader }),
			},
			warnings
		);
	});
}

async function a11yReset(ctx: CommandContext, deps: Deps, device: UiDevice): Promise<Result<UiSuccess, UiError>> {
	if (recordOf(ctx, device.lease.id, "a11y") === undefined) {
		return success(device, "a11y-reset", "a11y was not changed", { changed: false });
	}
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const done = fromDriver(await port.a11y(null));
		if (!done.success) return done;
		forget(ctx, device, "a11y");
		return success(device, "a11y-reset", "a11y reset", { changed: true });
	});
}

/** What `a11y status` says about the screen reader a recorded condition left on. */
function screenReaderOf(record: A11yCondition | undefined, platform: UiDevice["platform"]) {
	if (record?.screenReader !== true) return { mode: "off" } as const;
	return platform === "android"
		? ({ mode: "real", engine: "talkback" } as const)
		: ({ mode: "simulated", engine: "voiceover" } as const);
}

/**
 * `warden ui a11y set [--text-size <name|scale>] [--bold] [--contrast increased|normal] [--reduce-motion]
 * [--screen-reader] [--reduce-transparency] [--button-shapes] [--differentiate-without-color] [--on-off-labels]
 * [--high-contrast-text] [--color-inversion]` (each with a `--no-…`) · `reset` · `status`; and the read-side verbs
 * `audit` · `order` · `speak <locator>` · `announcements` · `spoken` · `focus next|prev|activate|status` (`a11y.ts`).
 */
export async function uiA11y(
	ctx: CommandContext,
	deps: UiDeps,
	action: string,
	rest: readonly string[],
	opts: A11yOptionValues & A11yVerbOptions
): Promise<number> {
	const { A11Y_VERBS, isA11yVerb, uiA11yVerb } = await import("./a11y");
	if (isA11yVerb(action)) return uiA11yVerb(ctx, deps, action, rest, opts);
	return runUi(ctx, deps, `a11y ${action}`, opts, async (device) => {
		if (rest.length > 0 && (action === "set" || action === "reset" || action === "status")) {
			return unexpected(action, rest, "a11y");
		}
		switch (action) {
			case "set":
				return a11ySet(ctx, await resolveDeps(deps), device, opts);
			case "reset":
				return a11yReset(ctx, await resolveDeps(deps), device);
			case "status": {
				const record = recordOf(ctx, device.lease.id, "a11y")?.value;
				const screenReader = screenReaderOf(record, device.platform);
				const reader =
					screenReader.mode === "off"
						? ""
						: `\nscreen reader  ${screenReader.mode} (${screenReader.engine}${screenReader.mode === "simulated" ? ": a flag the app reads, not VoiceOver" : ""})`;
				return success(
					device,
					"a11y-status",
					record === undefined ? "a11y  not changed" : `a11y  ${JSON.stringify(record)}${reader}`,
					{ a11y: record ?? null, screenReader }
				);
			}
			default:
				return fail("usage", `unknown a11y action "${action}"`, `set, reset, status, ${A11Y_VERBS.join(", ")}`);
		}
	});
}

// ---------- battery ----------

async function batterySet(
	ctx: CommandContext,
	deps: Deps,
	device: UiDevice,
	opts: BatteryOptionValues
): Promise<Result<UiSuccess, UiError>> {
	const op: { level?: number; charging?: boolean } = {};
	if (opts.level !== undefined) {
		const level = parseLevel(opts.level);
		if (!level.success) return fail("usage", level.error);
		op.level = level.data;
	}
	if (opts.charging !== undefined) op.charging = opts.charging;
	if (Object.keys(op).length === 0)
		return fail("usage", "battery set needs --level <0-100> and/or --charging / --no-charging");
	return withPort<UiSuccess>(ctx, deps, device, async (port) => {
		const applied = fromDriver(await port.battery(op));
		if (!applied.success) return applied;
		const previous = recordOf(ctx, device.lease.id, "battery")?.value ?? {};
		const next: BatteryCondition = { ...previous, ...op, cosmetic: applied.data.cosmetic };
		const saved = save(ctx, device, "battery", next);
		if (!saved.success) return saved;
		const cosmetic = applied.data.cosmetic;
		return success(
			device,
			"battery-set",
			`battery ${op.level === undefined ? "" : `${op.level}% `}${op.charging === undefined ? "" : op.charging ? "charging" : "unplugged"}`.trim(),
			{ ...op, cosmetic },
			cosmetic ? ["cosmetic: only the status bar changes, the app still reads the real battery"] : []
		);
	});
}

/** `warden ui battery set [--level <0-100>] [--charging|--no-charging]` · `reset` · `status`. Android emulator: real; iOS: status bar only. */
export function uiBattery(
	ctx: CommandContext,
	deps: UiDeps,
	action: string,
	opts: BatteryOptionValues
): Promise<number> {
	return runUi(ctx, deps, `battery ${action}`, opts, async (device) => {
		switch (action) {
			case "set":
				return batterySet(ctx, await resolveDeps(deps), device, opts);
			case "reset": {
				if (recordOf(ctx, device.lease.id, "battery") === undefined) {
					return success(device, "battery-reset", "battery was not changed", { changed: false });
				}
				return withPort<UiSuccess>(ctx, await resolveDeps(deps), device, async (port) => {
					const done = fromDriver(await port.battery(null));
					if (!done.success) return done;
					forget(ctx, device, "battery");
					return success(device, "battery-reset", "battery reset", { changed: true });
				});
			}
			case "status": {
				const record = recordOf(ctx, device.lease.id, "battery")?.value;
				return success(
					device,
					"battery-status",
					record === undefined ? "battery  not changed" : `battery  ${JSON.stringify(record)}`,
					{
						battery: record ?? null,
					}
				);
			}
			default:
				return fail("usage", `unknown battery action "${action}"`, "set, reset or status");
		}
	});
}

// ---------- memory warning, push ----------

/** `warden ui memory-warning [--app <bundle>]`: Android sends a critical trim to the running app; iOS has no working mechanism (E_UNSUPPORTED). */
export function uiMemoryWarning(ctx: CommandContext, deps: UiDeps, opts: AppOptionValues): Promise<number> {
	return runUi(ctx, deps, "memory-warning", opts, async (device) =>
		withPort<UiSuccess>(ctx, await resolveDeps(deps), device, async (port) => {
			const sent = fromDriver(await port.memoryWarning(appOf(ctx, device, opts.app)));
			return sent.success ? success(device, "memory-warning", "memory warning sent", {}) : sent;
		})
	);
}

/** `warden ui push <payload.json|'{"aps":…}'> [--app <bundle>]`: iOS `simctl push`; Android is E_UNSUPPORTED. */
export function uiPush(ctx: CommandContext, deps: UiDeps, payload: string, opts: AppOptionValues): Promise<number> {
	return runUi(ctx, deps, "push", opts, async (device) => {
		const parsed = parsePushPayload(payload, ctx.cwd);
		if (!parsed.success) return fail("usage", parsed.error);
		return withPort<UiSuccess>(ctx, await resolveDeps(deps), device, async (port) => {
			const sent = fromDriver(await port.push(parsed.data, appOf(ctx, device, opts.app)));
			return sent.success ? success(device, "push", "push delivered", {}) : sent;
		});
	});
}
