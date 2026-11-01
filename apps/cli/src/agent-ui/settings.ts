import type {
	A11yCondition,
	BatteryCondition,
	ConditionRecord,
	ConditionValues,
	LocaleCondition,
	PermissionCondition,
	PermissionName,
	PermissionState,
} from "@delacour/warden-config/conditions.types";
import { textSizes } from "@delacour/warden-config/text-size";
import { leaseConditions } from "@delacour/warden-core/conditions/conditions";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { uiConditions } from "./conditions";
import type { ConditionsDeps } from "./conditions-types";
import type { UiDevice } from "./device";
import { opErrors, type UiDeps } from "./driver";
import type { UiError, UiSuccess } from "./output";
import { type UiOptionValues, uiRun } from "./run";
import { uiSettingsParse } from "./settings-parse";
import { uiStatePersistence } from "./state";

/** Flags of the device-setting verbs that name an app. */
export type AppOptionValues = UiOptionValues & { app?: string };

export type A11yOptionValues = UiOptionValues & {
	textSize?: string;
	bold?: boolean;
	contrast?: string;
	reduceMotion?: boolean;
};

export type BatteryOptionValues = UiOptionValues & { level?: string; charging?: boolean };

type Deps = Required<ConditionsDeps>;

export class UiSettings {
	/** `--app`, else the app `warden ui open` last launched on the device, else the driver's own default. */
	private appOf(ctx: CommandContext, device: UiDevice, app: string | undefined): { bundleId?: string } {
		const bundleId = app ?? uiStatePersistence.readState(ctx, device.udid).app;
		return bundleId === undefined ? {} : { bundleId };
	}

	private save<A extends keyof ConditionValues>(
		ctx: CommandContext,
		device: UiDevice,
		area: A,
		value: ConditionValues[A]
	): Result<undefined, UiError> {
		const saved = leaseConditions.record(ctx.store(), device.lease.id, area, value, ctx.now());
		return saved.success
			? resultFactory.ok(undefined)
			: uiConditions.fail("failed", `could not record the ${area} condition: ${saved.error}`);
	}

	private forget(ctx: CommandContext, device: UiDevice, area: ConditionRecord["area"]): void {
		leaseConditions.clear(ctx.store(), device.lease.id, area);
	}

	private success(
		device: UiDevice,
		action: string,
		text: string,
		result: Record<string, unknown>,
		warnings: readonly string[] = []
	): Result<UiSuccess, UiError> {
		return resultFactory.ok({
			device: uiConditions.deviceInfo(device),
			result: { action, ...result },
			text,
			...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
		});
	}

	private unexpected(action: string, rest: readonly string[], verb: string): { success: false; error: UiError } {
		return uiConditions.fail("usage", `unexpected argument "${rest[0] ?? ""}" for ${verb} ${action}`);
	}

	// ---------- permission ----------
	private grantText(c: PermissionCondition | undefined): string {
		return c === undefined || c.grants.length === 0
			? "no permissions changed"
			: c.grants.map((g) => `${g.permission}=${g.state}`).join(" ");
	}

	/** The recorded grants with `fresh` replacing any earlier state of the same app + permission. */
	private mergedGrants(
		record: PermissionCondition | undefined,
		bundleId: string,
		fresh: readonly { permission: PermissionName; state: PermissionState }[]
	): PermissionCondition {
		const kept = (record?.grants ?? []).filter(
			(g) => !(g.bundleId === bundleId && fresh.some((f) => f.permission === g.permission))
		);
		return { grants: [...kept, ...fresh.map((f) => ({ bundleId, ...f }))] };
	}

	private async permissionSet(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		rest: readonly string[],
		opts: AppOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const grants = uiSettingsParse.parsePermissionPairs(rest);
		if (!grants.success) return uiConditions.fail("usage", grants.error);
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(await port.permissions(grants.data, this.appOf(ctx, device, opts.app)));
			if (!applied.success) return applied;
			const state = applied.data;
			const previous = uiConditions.recordOf(ctx, device.lease.id, "permission")?.value;
			const merged = this.mergedGrants(previous, state.bundleId, state.applied);
			const saved = this.save(ctx, device, "permission", merged);
			if (!saved.success) return saved;
			const warnings = state.skipped.map((s) => `${s.permission} not applied: ${s.reason}`);
			return this.success(
				device,
				"permission-set",
				`${state.bundleId}: ${state.applied.map((a) => `${a.permission}=${a.state}`).join(" ")}`,
				{ bundleId: state.bundleId, applied: state.applied, skipped: state.skipped },
				warnings
			);
		});
	}

	private async permissionReset(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		opts: AppOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const record = uiConditions.recordOf(ctx, device.lease.id, "permission");
		if (record === undefined || record.value.grants.length === 0) {
			return this.success(device, "permission-reset", "no permissions were changed", { changed: false });
		}
		const bundles = [...new Set(record.value.grants.map((g) => g.bundleId))].filter(
			(b) => opts.app === undefined || b === opts.app
		);
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			for (const bundleId of bundles) {
				const back: Partial<Record<PermissionName, PermissionState>> = {};
				for (const g of record.value.grants) if (g.bundleId === bundleId) back[g.permission] = "unset";
				const done = await port.permissions(back, { bundleId });
				// an app that does not declare the permission has nothing to reset
				if (!done.success && done.error.code !== "E_UNSUPPORTED")
					return { success: false, error: opErrors.driverError(done.error) };
			}
			const rest = record.value.grants.filter((g) => !bundles.includes(g.bundleId));
			if (rest.length === 0) this.forget(ctx, device, "permission");
			else {
				const saved = this.save(ctx, device, "permission", { grants: rest });
				if (!saved.success) return saved;
			}
			return this.success(device, "permission-reset", `permissions reset for ${bundles.join(", ")}`, {
				changed: true,
				bundles,
			});
		});
	}

	/**
	 * `warden ui permission set <name>=<granted|denied|unset>... [--app <bundle>]` · `reset [--app]` · `status`.
	 * iOS: `simctl privacy` (terminates a running app); Android: `pm grant|revoke`. Set before `open`. Recorded on the lease.
	 */
	uiPermission(
		ctx: CommandContext,
		deps: UiDeps,
		action: string,
		rest: readonly string[],
		opts: AppOptionValues
	): Promise<number> {
		return uiRun.runUi(ctx, deps, `permission ${action}`, opts, async (device) => {
			const real = await uiConditions.resolveDeps(deps);
			switch (action) {
				case "set":
					return this.permissionSet(ctx, real, device, rest, opts);
				case "reset":
					return rest.length > 0
						? this.unexpected(action, rest, "permission")
						: this.permissionReset(ctx, real, device, opts);
				case "status": {
					const record = uiConditions.recordOf(ctx, device.lease.id, "permission");
					return this.success(device, "permission-status", `permissions  ${this.grantText(record?.value)}`, {
						grants: record?.value.grants ?? [],
					});
				}
				default:
					return uiConditions.fail("usage", `unknown permission action "${action}"`, "set, reset or status");
			}
		});
	}

	// ---------- timezone and locale ----------
	private localeText(c: LocaleCondition | undefined): string {
		const parts = [
			c?.timezone === undefined ? undefined : `timezone ${c.timezone}`,
			c?.locale === undefined ? undefined : `locale ${c.locale}${c.bundleId === undefined ? "" : ` (${c.bundleId})`}`,
		].filter((p): p is string => p !== undefined);
		return parts.length === 0 ? "not changed" : parts.join(", ");
	}

	/** Store `value`, or forget the area when it holds nothing. */
	private saveLocale(ctx: CommandContext, device: UiDevice, value: LocaleCondition): Result<undefined, UiError> {
		if (value.timezone === undefined && value.locale === undefined) {
			this.forget(ctx, device, "locale");
			return resultFactory.ok(undefined);
		}
		return this.save(ctx, device, "locale", value);
	}

	private async timezoneApply(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		arg: string
	): Promise<Result<UiSuccess, UiError>> {
		const record = uiConditions.recordOf(ctx, device.lease.id, "locale")?.value ?? {};
		const resetting = arg === "reset";
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(
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
			const saved = this.saveLocale(ctx, device, next);
			if (!saved.success) return saved;
			const staged = applied.data.appliesOnLaunch === true;
			return this.success(
				device,
				resetting ? "timezone-reset" : "timezone-set",
				resetting ? "timezone reset" : `timezone ${arg}${staged ? " (next launch)" : ""}`,
				{ timezone: resetting ? null : arg, staged, previous: applied.data.previous ?? null },
				staged ? ["staged: a simulator has no device timezone; the app launched next gets it (`open --relaunch`)"] : []
			);
		});
	}

	/** `warden ui timezone <tz|reset|status>`: Android `cmd alarm set-timezone` (device-wide, live); iOS staged for the next launch. */
	uiTimezone(ctx: CommandContext, deps: UiDeps, arg: string, opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, `timezone ${arg === "status" ? "status" : "set"}`, opts, async (device) => {
			if (arg === "status") {
				const record = uiConditions.recordOf(ctx, device.lease.id, "locale")?.value;
				return this.success(device, "timezone-status", `timezone  ${record?.timezone ?? "not changed"}`, {
					timezone: record?.timezone ?? null,
				});
			}
			return this.timezoneApply(ctx, await uiConditions.resolveDeps(deps), device, arg);
		});
	}

	private async localeApply(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		arg: string,
		opts: AppOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const record = uiConditions.recordOf(ctx, device.lease.id, "locale")?.value ?? {};
		const resetting = arg === "reset";
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(
				await port.locale(resetting ? null : arg, this.appOf(ctx, device, opts.app ?? record.bundleId))
			);
			if (!applied.success) return applied;
			const { locale: _drop, bundleId: _app, ...rest } = record;
			const bundleId = applied.data.bundleId;
			const next: LocaleCondition = resetting
				? rest
				: { ...rest, locale: arg, ...(bundleId === undefined ? {} : { bundleId }) };
			const saved = this.saveLocale(ctx, device, next);
			if (!saved.success) return saved;
			const staged = applied.data.appliesOnLaunch === true;
			return this.success(
				device,
				resetting ? "locale-reset" : "locale-set",
				resetting ? "locale reset" : `locale ${arg}${staged ? " (next launch)" : ""}`,
				{ locale: resetting ? null : arg, bundleId: bundleId ?? null, staged },
				staged ? ["staged: the app launched next gets it (`open --relaunch`)"] : []
			);
		});
	}

	/** `warden ui locale <tag|reset|status> [--app <bundle>]`: Android 13+ per-app locale (live); iOS staged for the next launch. */
	uiLocale(ctx: CommandContext, deps: UiDeps, arg: string, opts: AppOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, `locale ${arg === "status" ? "status" : "set"}`, opts, async (device) => {
			if (arg === "status") {
				const record = uiConditions.recordOf(ctx, device.lease.id, "locale")?.value;
				return this.success(device, "locale-status", `locale  ${this.localeText(record)}`, {
					locale: record?.locale ?? null,
					timezone: record?.timezone ?? null,
				});
			}
			return this.localeApply(ctx, await uiConditions.resolveDeps(deps), device, arg, opts);
		});
	}

	// ---------- a11y ----------
	private a11yOpOf(opts: A11yOptionValues): Result<NonNullable<A11yCondition>, UiError> {
		const op: A11yCondition = {};
		if (opts.textSize !== undefined) {
			const size = uiSettingsParse.parseTextSizeArg(opts.textSize);
			if (!size.success) return uiConditions.fail("usage", size.error);
			op.textSize = size.data;
		}
		if (opts.bold !== undefined) op.boldText = opts.bold;
		if (opts.reduceMotion !== undefined) op.reduceMotion = opts.reduceMotion;
		if (opts.contrast !== undefined) {
			if (opts.contrast !== "increased" && opts.contrast !== "normal") {
				return uiConditions.fail("usage", `--contrast must be increased or normal, got "${opts.contrast}"`);
			}
			op.contrast = opts.contrast;
		}
		return Object.keys(op).length === 0
			? uiConditions.fail("usage", "a11y set needs one of --text-size, --bold, --contrast, --reduce-motion")
			: resultFactory.ok(op);
	}

	private async a11ySet(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		opts: A11yOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const op = this.a11yOpOf(opts);
		if (!op.success) return op;
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(await port.a11y(op.data));
			if (!applied.success) return applied;
			const resolved = op.data.textSize === undefined ? undefined : textSizes.resolveTextSize(op.data.textSize);
			const previous = uiConditions.recordOf(ctx, device.lease.id, "a11y")?.value ?? {};
			const next: A11yCondition = {
				...previous,
				...textSizes.appliedA11y(op.data, applied.data.applied),
				...(resolved?.success ? { fontScale: resolved.data.scale } : {}),
			};
			const saved = this.save(ctx, device, "a11y", next);
			if (!saved.success) return saved;
			const warnings = [
				...applied.data.skipped.map((s) => `${s.setting} not applied: ${s.reason}`),
				...applied.data.notes,
			];
			return this.success(
				device,
				"a11y-set",
				`a11y ${applied.data.applied.join(", ")}`,
				{ applied: applied.data.applied, skipped: applied.data.skipped },
				warnings
			);
		});
	}

	private async a11yReset(ctx: CommandContext, deps: Deps, device: UiDevice): Promise<Result<UiSuccess, UiError>> {
		if (uiConditions.recordOf(ctx, device.lease.id, "a11y") === undefined) {
			return this.success(device, "a11y-reset", "a11y was not changed", { changed: false });
		}
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const done = opErrors.fromDriver(await port.a11y(null));
			if (!done.success) return done;
			this.forget(ctx, device, "a11y");
			return this.success(device, "a11y-reset", "a11y reset", { changed: true });
		});
	}

	/** `warden ui a11y set [--text-size <name|scale>] [--bold] [--contrast increased|normal] [--reduce-motion]` · `reset` · `status`. */
	uiA11y(ctx: CommandContext, deps: UiDeps, action: string, opts: A11yOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, `a11y ${action}`, opts, async (device) => {
			switch (action) {
				case "set":
					return this.a11ySet(ctx, await uiConditions.resolveDeps(deps), device, opts);
				case "reset":
					return this.a11yReset(ctx, await uiConditions.resolveDeps(deps), device);
				case "status": {
					const record = uiConditions.recordOf(ctx, device.lease.id, "a11y")?.value;
					return this.success(
						device,
						"a11y-status",
						record === undefined ? "a11y  not changed" : `a11y  ${JSON.stringify(record)}`,
						{
							a11y: record ?? null,
						}
					);
				}
				default:
					return uiConditions.fail("usage", `unknown a11y action "${action}"`, "set, reset or status");
			}
		});
	}

	// ---------- battery ----------
	private async batterySet(
		ctx: CommandContext,
		deps: Deps,
		device: UiDevice,
		opts: BatteryOptionValues
	): Promise<Result<UiSuccess, UiError>> {
		const op: { level?: number; charging?: boolean } = {};
		if (opts.level !== undefined) {
			const level = uiSettingsParse.parseLevel(opts.level);
			if (!level.success) return uiConditions.fail("usage", level.error);
			op.level = level.data;
		}
		if (opts.charging !== undefined) op.charging = opts.charging;
		if (Object.keys(op).length === 0)
			return uiConditions.fail("usage", "battery set needs --level <0-100> and/or --charging / --no-charging");
		return uiConditions.withPort<UiSuccess>(ctx, deps, device, async (port) => {
			const applied = opErrors.fromDriver(await port.battery(op));
			if (!applied.success) return applied;
			const previous = uiConditions.recordOf(ctx, device.lease.id, "battery")?.value ?? {};
			const next: BatteryCondition = { ...previous, ...op, cosmetic: applied.data.cosmetic };
			const saved = this.save(ctx, device, "battery", next);
			if (!saved.success) return saved;
			const cosmetic = applied.data.cosmetic;
			return this.success(
				device,
				"battery-set",
				`battery ${op.level === undefined ? "" : `${op.level}% `}${op.charging === undefined ? "" : op.charging ? "charging" : "unplugged"}`.trim(),
				{ ...op, cosmetic },
				cosmetic ? ["cosmetic: only the status bar changes, the app still reads the real battery"] : []
			);
		});
	}

	/** `warden ui battery set [--level <0-100>] [--charging|--no-charging]` · `reset` · `status`. Android emulator: real; iOS: status bar only. */
	uiBattery(ctx: CommandContext, deps: UiDeps, action: string, opts: BatteryOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, `battery ${action}`, opts, async (device) => {
			switch (action) {
				case "set":
					return this.batterySet(ctx, await uiConditions.resolveDeps(deps), device, opts);
				case "reset": {
					if (uiConditions.recordOf(ctx, device.lease.id, "battery") === undefined) {
						return this.success(device, "battery-reset", "battery was not changed", { changed: false });
					}
					return uiConditions.withPort<UiSuccess>(ctx, await uiConditions.resolveDeps(deps), device, async (port) => {
						const done = opErrors.fromDriver(await port.battery(null));
						if (!done.success) return done;
						this.forget(ctx, device, "battery");
						return this.success(device, "battery-reset", "battery reset", { changed: true });
					});
				}
				case "status": {
					const record = uiConditions.recordOf(ctx, device.lease.id, "battery")?.value;
					return this.success(
						device,
						"battery-status",
						record === undefined ? "battery  not changed" : `battery  ${JSON.stringify(record)}`,
						{
							battery: record ?? null,
						}
					);
				}
				default:
					return uiConditions.fail("usage", `unknown battery action "${action}"`, "set, reset or status");
			}
		});
	}

	// ---------- memory warning, push ----------

	/** `warden ui memory-warning [--app <bundle>]`: Android sends a critical trim to the running app; iOS has no working mechanism (E_UNSUPPORTED). */
	uiMemoryWarning(ctx: CommandContext, deps: UiDeps, opts: AppOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "memory-warning", opts, async (device) =>
			uiConditions.withPort<UiSuccess>(ctx, await uiConditions.resolveDeps(deps), device, async (port) => {
				const sent = opErrors.fromDriver(await port.memoryWarning(this.appOf(ctx, device, opts.app)));
				return sent.success ? this.success(device, "memory-warning", "memory warning sent", {}) : sent;
			})
		);
	}

	/** `warden ui push <payload.json|'{"aps":…}'> [--app <bundle>]`: iOS `simctl push`; Android is E_UNSUPPORTED. */
	uiPush(ctx: CommandContext, deps: UiDeps, payload: string, opts: AppOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "push", opts, async (device) => {
			const parsed = uiSettingsParse.parsePushPayload(payload, ctx.cwd);
			if (!parsed.success) return uiConditions.fail("usage", parsed.error);
			return uiConditions.withPort<UiSuccess>(ctx, await uiConditions.resolveDeps(deps), device, async (port) => {
				const sent = opErrors.fromDriver(await port.push(parsed.data, this.appOf(ctx, device, opts.app)));
				return sent.success ? this.success(device, "push", "push delivered", {}) : sent;
			});
		});
	}
}

export const uiSettings = new UiSettings();
