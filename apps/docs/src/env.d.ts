/** The build-time variables this app reads. All optional; see `src/lib/analytics/config.ts`. */
interface ImportMetaEnv {
	readonly VITE_POSTHOG_TOKEN?: string;
	readonly VITE_POSTHOG_HOST?: string;
}
