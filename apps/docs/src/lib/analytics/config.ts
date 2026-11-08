import { siteUrl, stagingHost } from "@/lib/shared";

/**
 * Which analytics provider this build talks to, read from the environment.
 *
 * Both variables are optional, and a missing or malformed one turns PostHog
 * off rather than throwing, so `bun run dev` and CI, which set neither, render
 * a page with no analytics at all. The values are `VITE_*` and therefore
 * inlined at build time, into the client bundle and the server one alike,
 * which is why Railway sets them per environment: the same token and
 * `i.delacour.co.nz` proxy as every Delacour site (delacour-monorepo's
 * `wardenAnalyticsEnv`).
 *
 * The validation is not pedantry: the values go into the SDK's config and a
 * server-side URL, so a value that is not the shape it claims to be is refused
 * before it can reach either.
 */

/** `host` is an https origin, with no path or trailing slash. */
export type PosthogConfig = { kind: "off" } | { kind: "on"; token: string; host: string };

export type AnalyticsConfig = { posthog: PosthogConfig };

export type AnalyticsEnv = {
	VITE_POSTHOG_TOKEN?: string;
	VITE_POSTHOG_HOST?: string;
};

/** A public project token. A personal API key (`phx_`) is a secret and is refused. */
const POSTHOG_TOKEN = /^phc_[A-Za-z0-9]+$/;

function httpsOrigin(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}

export function analyticsConfig(env: AnalyticsEnv): AnalyticsConfig {
	const token = env.VITE_POSTHOG_TOKEN;
	const host = httpsOrigin(env.VITE_POSTHOG_HOST);

	return {
		posthog: token && POSTHOG_TOKEN.test(token) && host ? { kind: "on", token, host } : { kind: "off" },
	};
}

/**
 * The hosts whose traffic is counted: production, and staging, which reports
 * to its own PostHog project. A production build run on `localhost` or reached
 * through Railway's own domain counts nothing.
 */
const COUNTED_HOSTS: ReadonlySet<string> = new Set([new URL(siteUrl).host, stagingHost]);

export function isCountedHost(host: string): boolean {
	return COUNTED_HOSTS.has(host);
}

/** This build's provider. */
export const ANALYTICS: AnalyticsConfig = analyticsConfig({
	VITE_POSTHOG_TOKEN: import.meta.env.VITE_POSTHOG_TOKEN,
	VITE_POSTHOG_HOST: import.meta.env.VITE_POSTHOG_HOST,
});
