/**
 * The slice of Expo's build cache provider contract `@delacour/warden/expo-build-cache` implements. Expo calls these
 * from its own CLI process, so the shapes are declared here rather than imported from `@expo/config`.
 */

/** `expo run:ios` / `expo run:android` options Expo hands the provider (only the ones it reads are named). */
export type ExpoRunOptions = {
	/** iOS: Xcode build configuration, `Debug` when omitted */
	configuration?: string;
	/** Android: Gradle variant */
	variant?: string;
	device?: string | boolean;
	binary?: string;
	[option: string]: unknown;
};

export type ExpoBuildCacheProps = {
	projectRoot: string;
	platform: "ios" | "android";
	runOptions: ExpoRunOptions;
};

export type ExpoFingerprintedProps = ExpoBuildCacheProps & {
	/** what `calculateFingerprintHash` returned */
	fingerprintHash: string;
};

export type ExpoUploadProps = ExpoFingerprintedProps & {
	/** the `.app` a local build just produced */
	buildPath: string;
};

/** The object `buildCacheProvider: { plugin: "@delacour/warden/expo-build-cache" }` loads. */
export type ExpoBuildCacheProvider = {
	/** warden's dev-kind key for the project, or null to leave this run to Expo (not iOS Debug, or not warden's default dev build) */
	calculateFingerprintHash: (props: ExpoBuildCacheProps, options?: unknown) => Promise<string | null>;
	/** the cached dev build's `.app`, or null on a miss */
	resolveBuildCache: (props: ExpoFingerprintedProps, options?: unknown) => Promise<string | null>;
	/** files the freshly built `.app` into warden's cache; the stored path, or null */
	uploadBuildCache: (props: ExpoUploadProps, options?: unknown) => Promise<string | null>;
};
