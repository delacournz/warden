import { createTelemetry, type Telemetry, type TelemetryOptions } from "@delacournz/cli-telemetry";
import { type BuildInfo, currentBuild } from "../update/build-info";

/**
 * The CLI's one telemetry instance.
 *
 * `@delacournz/cli-telemetry` is the shared client: environment detection, opt-out precedence, the
 * machine-local identity file, the project id and the bounded send. `bun build --compile` bundles it. Everything
 * specific to *this* product is here: its name, its version, its channel, what the notice tells people to type
 * and where they can read more.
 *
 * `TELEMETRY_HOST` is stated again, rather than only inherited, because `/privacy` is held to it: the docs
 * site's `privacy.test.ts` reads this file for the host and requires the policy to name it, and `client.test.ts`
 * holds it to the package's own endpoint.
 */

/** The ingest service's allowlisted slug for warden. */
export const TELEMETRY_PRODUCT = "warden";

/** Where events go: Delacour's own server, which derives a country from the request and drops the IP. */
export const TELEMETRY_HOST = "telemetry.delacour.co.nz";

/** The notice, `warden telemetry` and the privacy policy all point here. */
export const TELEMETRY_DOCS_URL = "https://warden.co.nz/docs/reference/cli#telemetry";

/**
 * A development or local build ends in `-dev`, which the client treats as "never report": only a published
 * release counts, so working on warden does not skew its own numbers.
 */
export function telemetryVersion(build: Pick<BuildInfo, "channel" | "version">): string {
	return build.channel === "release" ? build.version : `${build.version}-dev`;
}

export function createWardenTelemetry(overrides: Partial<TelemetryOptions> = {}): Telemetry {
	const build = currentBuild();
	return createTelemetry({
		product: TELEMETRY_PRODUCT,
		version: telemetryVersion(build),
		channel: build.channel,
		bin: "warden",
		docsUrl: TELEMETRY_DOCS_URL,
		...overrides,
	});
}

let instance: Telemetry | undefined;

/** Created on first use, so a process that never records never touches the disk. */
export function telemetry(): Telemetry {
	instance ??= createWardenTelemetry({ env: process.env });
	return instance;
}
