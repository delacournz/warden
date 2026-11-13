import type { A11yIssue } from "../a11y/a11y.types";
import type { Driver } from "./driver.types";

/** What a platform's own audit engine found, or why it did not run (never an error: a missing engine only skips it). */
export type NativeAuditResult = {
	issues: A11yIssue[];
	skipped?: { source: A11yIssue["source"]; reason: string };
};

export type NativeAuditOptions = {
	/** iOS: the app whose accessibility the XCUITest audit checks (required there; the audit needs it running) */
	bundleId?: string;
	/** Android: let ATF's contrast checks read a screenshot (default true) */
	contrast?: boolean;
};

/**
 * Optional capability next to the frozen `Driver` interface (pattern: `ReadsA11y` in `a11y-read.ts`): run the
 * platform's own accessibility audit on the screen now. iOS simulator: XCUITest `performAccessibilityAudit` through
 * the runner (`a11y/native/xcuitest.ts`). Android: the Accessibility Test Framework inside `warden-uiad`
 * (`a11y/native/atf.ts`). Resolves with `skipped` and a reason when the engine cannot run.
 */
export type AuditsNatively = { auditNatively(options?: NativeAuditOptions): Promise<NativeAuditResult> };

export function canAuditNatively(driver: Driver): driver is Driver & AuditsNatively {
	return typeof (driver as Partial<AuditsNatively>).auditNatively === "function";
}
