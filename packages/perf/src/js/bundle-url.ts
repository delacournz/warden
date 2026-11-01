/**
 * Metro serves bundles at `…/entry.bundle?query`, and React Native loads them in the "JSC-safe" form
 * `…/entry.bundle//&query` (JavaScriptCore drops a `?query` from source URLs). Hermes reports whichever URL the app
 * loaded, so every check on a bundle URL must accept both.
 */
const BUNDLE_URL = /^https?:\/\/[^\s]*\.bundle(?:\?|\/\/&|$)/;

export class BundleUrls {
	/** A Metro bundle URL, in either form. */
	isBundleUrl(url: string): boolean {
		return BUNDLE_URL.test(url);
	}

	/** The plain `?query` form of a bundle URL (what `new URL` can split into path and search). */
	toNormalBundleUrl(url: string): string {
		const at = url.indexOf("//&");
		return at < 0 || url.includes("?") ? url : `${url.slice(0, at)}?${url.slice(at + 3)}`;
	}
}

export const bundleUrls = new BundleUrls();
