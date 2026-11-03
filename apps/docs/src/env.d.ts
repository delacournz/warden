/** The build-time variables this app reads. All optional; see `src/lib/analytics/config.ts`. */
interface ImportMetaEnv {
	readonly VITE_POSTHOG_TOKEN?: string;
	readonly VITE_POSTHOG_HOST?: string;
}

/** Card path → content hash, defined by `vite.config.ts` from `public/og`; absent under `bun test`. */
declare const __OG_VERSIONS__: Record<string, string> | undefined;
