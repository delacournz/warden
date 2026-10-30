import type { A11yAuditOptions, A11yIssue } from "../a11y/a11y.types";
import type { A11yTarget } from "../a11y/a11y-target";
import { failing, formatIssues } from "../a11y/audit";
import type { DeviceA11yAuditOptions } from "../device-a11y";
import { toE2eError } from "../driver/unwrap";
import { E2eError } from "../errors";
import type { TextMatch } from "../screen/text";
import type { AssertionContext } from "./matchers";

export type AnnouncedOptions = {
	/** how long to wait for the announcement (default: the assertion timeout); `.not` waits this long for none */
	timeoutMs?: number;
	/** same as `timeoutMs`, spelled as the other matchers do */
	timeout?: number;
	/** cursor from `device.announcements()`: only what came after it counts (default: everything the device kept) */
	since?: number;
};

export type PassA11yAuditOptions = DeviceA11yAuditOptions;

function show(match: TextMatch): string {
	return typeof match === "string" ? JSON.stringify(match) : String(match);
}

function checkMillis(matcher: string, key: string, value: unknown): void {
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
		throw new E2eError("INVALID_ARGUMENT", `${matcher}: "${key}" must be a non-negative number of milliseconds`);
	}
}

/**
 * The matchers of `expect(device)` / `expect(screen)`: `toPassA11yAudit` and `toHaveAnnounced`. A failure carries the
 * issue table or the announcements seen, and the screen as text with the `--a11y` columns (`screen-at-failure.txt`).
 */
export class DeviceAssertions {
	constructor(
		private readonly target: A11yTarget,
		private readonly context: AssertionContext
	) {}

	get not(): DeviceAssertions {
		return new DeviceAssertions(this.target, { ...this.context, negate: !this.context.negate });
	}

	/**
	 * The screen as it is now has no issue at `minSeverity` (default `error`) or worse, from warden's rules and the
	 * platform's own audit. Takes the options of `device.a11yAudit` (suite `a11y` config applies); runs once, so settle
	 * first. Warnings (target size, platform guidelines) are reported only with `{ minSeverity: "warning" }`.
	 */
	async toPassA11yAudit(options: PassA11yAuditOptions = {}): Promise<void> {
		const call = `toPassA11yAudit(${Object.keys(options).length === 0 ? "" : JSON.stringify(options)})`;
		return this.run(call, async () => {
			const result = await this.target.audit(options as A11yAuditOptions);
			const min = options.minSeverity ?? "error";
			const bad: A11yIssue[] = failing(result, min);
			const passes = bad.length === 0;
			if (passes !== this.context.negate) return;
			const table = formatIssues(result, min);
			const lines = [
				`expect(device)${this.context.negate ? ".not" : ""}.${call}`,
				`Expected: ${this.context.negate ? "at least one" : "no"} ${min}${min === "error" ? "" : " or worse"} accessibility issue`,
				`Received: ${table}`,
			];
			throw await this.failure(lines);
		});
	}

	/** An announcement or live-region change whose text contains the string or matches the RegExp arrived (`.not`: none did within the timeout). */
	async toHaveAnnounced(expected: TextMatch, options: AnnouncedOptions = {}): Promise<void> {
		for (const key of Object.keys(options)) {
			if (key !== "timeoutMs" && key !== "timeout" && key !== "since") {
				throw new E2eError("INVALID_ARGUMENT", `toHaveAnnounced does not take "${key}"; it takes timeoutMs, since`);
			}
		}
		checkMillis("toHaveAnnounced", "timeoutMs", options.timeoutMs);
		checkMillis("toHaveAnnounced", "timeout", options.timeout);
		const timeoutMs = options.timeoutMs ?? options.timeout ?? this.target.assertionTimeout();
		const call = `toHaveAnnounced(${show(expected)})`;
		return this.run(call, async () => {
			const waited = await this.target.waitForAnnouncement(expected, {
				timeoutMs,
				...(options.since === undefined ? {} : { since: options.since }),
			});
			const { negate } = this.context;
			if (waited.success) {
				if (!negate) return;
				throw await this.failure([
					`expect(device).not.${call}`,
					`Expected: no announcement matching ${show(expected)}`,
					`Received: ${JSON.stringify(waited.data.event.text ?? "")}`,
				]);
			}
			if (waited.error.code !== "E_TIMEOUT") throw toE2eError(waited.error, "read announcements");
			if (negate) return;
			const seen = (waited.error.detail as { seen?: string[] } | undefined)?.seen ?? [];
			throw await this.failure([
				`expect(device).${call}`,
				`Expected: an announcement matching ${show(expected)} within ${timeoutMs} ms`,
				`Received: ${seen.length === 0 ? "(no announcements)" : seen.map((text) => JSON.stringify(text)).join(", ")}`,
			]);
		});
	}

	private async failure(lines: readonly string[]): Promise<E2eError> {
		const screen = await this.target.a11yScreen();
		const head = lines.join("\n");
		return new E2eError("ASSERTION", screen === undefined ? head : `${head}\n\n${screen}`, screen);
	}

	private async run(call: string, body: () => Promise<void>): Promise<void> {
		try {
			await this.target.step(`expect device.${call}`, body);
		} catch (error) {
			if (this.context.soft !== undefined && error instanceof E2eError && error.code !== "TIMEOUT") {
				this.context.soft(error);
				return;
			}
			throw error;
		}
	}
}
