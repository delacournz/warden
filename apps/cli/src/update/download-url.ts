import { err, ok, type Result } from "@delacour/warden-types/result";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(url: string): URL | undefined {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

/**
 * A download location set through the environment (`name`): `https:` anywhere, `http:` on this machine only
 * (`localhost`, `127.0.0.1`, `[::1]`: a local registry or mirror), or `file:`. What is fetched from it is installed
 * or run, so it never travels in the clear.
 */
export function checkDownloadUrl(url: string, name: string): Result<string> {
	const parsed = parse(url);
	const allowed =
		parsed !== undefined &&
		(parsed.protocol === "https:" ||
			parsed.protocol === "file:" ||
			(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)));
	if (allowed) return ok(url);
	return err(
		`${name} must be an https: URL (http: only for localhost / 127.0.0.1, or file:), got ${JSON.stringify(url)}`
	);
}

/** Same scheme, host and port: `file:` URLs (no host) are each other's origin. */
export function sameOrigin(a: string, b: string): boolean {
	const x = parse(a);
	const y = parse(b);
	return x !== undefined && y !== undefined && x.protocol === y.protocol && x.host === y.host;
}
