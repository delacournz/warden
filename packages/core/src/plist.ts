/**
 * A boolean as `plutil -extract <key> raw` prints it: `true` / `false` for a plist `<true/>` / `<false/>`, `1` / `0` for
 * an integer. A booted simulator rewrites `AutomationEnabled` as the integer 1 (whatever `-bool true` wrote), so a check
 * for `true` alone never matched it. Anything else is unknown.
 */
export function plistBool(stdout: string): boolean | undefined {
	const raw = stdout.trim();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return undefined;
}
