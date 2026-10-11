export const WARDEN_RULE_LINE =
	"0. **Claim via warden first** - run `warden claim ios|android --json` and use the returned udid/serial before booting or choosing a device; never use a device leased by another session (`warden ls`, `warden check --udid X`). A bare claim lasts ~5 min; only `warden dev|run|batch|e2e` or `warden heartbeat` hold a device longer.";

export type RulesPatch =
	| { kind: "patched"; text: string }
	| { kind: "unchanged"; reason: "already-patched" | "no-rule" };

const OPEN_TAG = "<device_selection_rule>";

/** Insert the warden step into argent's `<device_selection_rule>` (before step 1). Pure + idempotent. */
export function patchArgentRules(text: string): RulesPatch {
	const open = text.indexOf(OPEN_TAG);
	if (open === -1) return { kind: "unchanged", reason: "no-rule" };
	if (/warden/i.test(text)) return { kind: "unchanged", reason: "already-patched" };
	const close = text.indexOf("</device_selection_rule>", open);
	const body = text.slice(open, close === -1 ? undefined : close);
	const step = /^1\. /m.exec(body);
	if (step) {
		const at = open + step.index;
		return { kind: "patched", text: `${text.slice(0, at)}${WARDEN_RULE_LINE}\n${text.slice(at)}` };
	}
	const lineEnd = text.indexOf("\n", open);
	const at = lineEnd === -1 ? text.length : lineEnd + 1;
	const sep = lineEnd === -1 ? "\n" : "";
	return { kind: "patched", text: `${text.slice(0, at)}${sep}${WARDEN_RULE_LINE}\n${text.slice(at)}` };
}
