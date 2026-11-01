import type { Core } from "../../core";
import type { AuthoringDeps } from "./deps";

/** The authoring seam a client starts from. */
export class AuthoringDefaults {
	/**
	 * The authoring deps a client uses: the injected seam, with `verify` defaulting to the specs runner
	 * (`default-verify.ts`, loaded on first use so the spec machinery stays off the client's cold start).
	 */
	authoringFor(core: Core): AuthoringDeps {
		const seam = core.seams.authoring ?? {};
		return {
			...seam,
			verify:
				seam.verify ??
				(async (input) => {
					const { specsVerifier } = await import("./default-verify");
					return specsVerifier.specsVerify(core)(input);
				}),
		};
	}
}

export const authoringDefaults = new AuthoringDefaults();
