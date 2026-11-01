import type { Core } from "../../core";
import type { AuthoringDeps } from "./deps";

/**
 * The authoring deps a client uses: the injected seam, with `verify` defaulting to the specs runner
 * (`default-verify.ts`, loaded on first use so the spec machinery stays off the client's cold start).
 */
export function authoringFor(core: Core): AuthoringDeps {
	const seam = core.seams.authoring ?? {};
	return {
		...seam,
		verify:
			seam.verify ??
			(async (input) => {
				const { specsVerify } = await import("./default-verify");
				return specsVerify(core)(input);
			}),
	};
}
