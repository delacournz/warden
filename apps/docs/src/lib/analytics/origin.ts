/**
 * The https origin of a configured host, or `null` for anything that is not
 * one. Its own module, with no imports, because two readers of
 * `VITE_POSTHOG_HOST` share it and one of them, `http-cache.ts`, is loaded by
 * `vite.config.ts` before there is a bundle: the browser SDK's `api_host`
 * (`config.ts`) and the content security policy's `connect-src`.
 */
export function httpsOrigin(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}
