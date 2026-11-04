import type { Result } from "@delacour/warden-types/result";
import type { DriverError } from "../driver/driver.types";
import type { A11yAuditOptions, A11yAuditResult } from "./a11y.types";
import type { AnnouncementMatch } from "./announcements";

/** What `toPassA11yAudit` / `toHaveAnnounced` need of a `device` (or the `screen` beside it), reached through {@link a11yTargetOf}. */
export type A11yTarget = {
	/** the audit `device.a11yAudit` runs, suite defaults applied */
	audit(options: A11yAuditOptions): Promise<A11yAuditResult>;
	/** polls announcements and live-region changes until one matches `match` or `timeoutMs` passes (`E_TIMEOUT`) */
	waitForAnnouncement(
		match: string | RegExp,
		options: { timeoutMs: number; since?: number }
	): Promise<Result<AnnouncementMatch, DriverError>>;
	/** the current screen as text with the `--a11y` columns (failure evidence); undefined when it cannot be read */
	a11yScreen(): Promise<string | undefined>;
	/** the assertion timeout in ms */
	assertionTimeout(): number;
	/** one reported step */
	step<T>(label: string, fn: () => Promise<T>): Promise<T>;
};

const registry = new WeakMap<object, A11yTarget>();

/** Ties a device (and the screen made beside it, or a wrapper of either) to its a11y hooks; `Device` itself does not expose them. */
export function registerA11yTarget(target: object, hooks: A11yTarget): void {
	registry.set(target, hooks);
}

export function a11yTargetOf(target: unknown): A11yTarget | undefined {
	return typeof target === "object" && target !== null ? registry.get(target) : undefined;
}
