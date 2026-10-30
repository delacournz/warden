import type { Platform, Role } from "../driver/driver.types";

/** Where a spoken line or issue came from: warden's own model, or a real platform engine. */
export type A11ySource = "simulated" | "talkback" | "xcuitest" | "atf" | "warden";

/** What a screen reader says for one element, split so matchers can check each part. */
export type Announcement = {
	/** element id in the snapshot it came from */
	id: string;
	identifier?: string;
	/** the full phrase, parts joined in the platform's order */
	text: string;
	role: Role;
	platform: Platform;
	source: A11ySource;
	parts: {
		label?: string;
		value?: string;
		/** spoken role word: "button", "heading", "switch button" */
		role?: string;
		/** spoken states: "selected", "dimmed", "on", "not checked" */
		state: readonly string[];
		hint?: string;
	};
};

export type A11yRuleId =
	| "missing-name"
	| "image-no-name"
	| "target-size"
	| "target-size-platform"
	| "duplicate-name"
	| "role-in-name"
	| "label-in-name"
	| "hidden-focusable"
	| "text-clipped"
	| "native";

export type A11ySeverity = "error" | "warning";

export type A11yIssue = {
	rule: A11yRuleId;
	severity: A11ySeverity;
	/** WCAG 2.2 success criterion, e.g. "2.5.8" */
	wcag?: string;
	source: Exclude<A11ySource, "simulated" | "talkback">;
	elementId?: string;
	identifier?: string;
	message: string;
};

export type A11yIgnore = { rule: A11yRuleId; identifier?: string };

export type A11yAuditOptions = {
	rules?: readonly A11yRuleId[];
	ignore?: readonly A11yIgnore[];
	/** lowest severity that fails `toPassA11yAudit` / `warden ui a11y audit`; default "error" */
	minSeverity?: A11ySeverity;
};

export type A11yAuditResult = {
	issues: readonly A11yIssue[];
	checked: number;
	sources: readonly A11yIssue["source"][];
	skipped: readonly { source: A11yIssue["source"]; reason: string }[];
};

export type ScreenReaderState =
	| { mode: "real"; engine: "talkback" }
	| { mode: "simulated"; engine: "voiceover" }
	| { mode: "off" };

export type SpokenLine = { text: string; at: number; source: A11ySource };
