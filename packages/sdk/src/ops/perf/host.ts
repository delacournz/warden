import { metroOwner } from "@delacour/warden-builds/metro";
import { findMetro } from "@delacour/warden-devtools/metro";
import { resolveOwner } from "@delacour/warden-leasing/owner";
import { sameOwner } from "@delacour/warden-store/types";
import { readMetroUrl } from "./device-state";
import type { PerfHostDeps } from "./types";

/** Real host facts: the Metro lookup the device's remembered URL, `WARDEN_METRO_URL` and the owner's leased ports feed. */
export const defaultPerfHostDeps: PerfHostDeps = {
	platform: process.platform,
	metro: async (env, udid) => {
		const owner = resolveOwner(env);
		const stateUrl = udid === undefined ? undefined : readMetroUrl(env, udid);
		const portLeases = env
			.store()
			.listLeases()
			.flatMap((l) => (l.resource.kind === "port" && sameOwner(l.owner, owner) ? [l.resource.port] : []));
		const found = await findMetro({
			...(env.env.WARDEN_METRO_URL === undefined ? {} : { env: env.env.WARDEN_METRO_URL }),
			...(stateUrl === undefined ? {} : { stateMetroUrl: stateUrl }),
			portLeases,
			probe: async (port) => {
				const probed = await metroOwner(env.exec, port, env.cwd);
				return probed.kind === "ours" ? "ours" : probed.kind === "foreign" ? "foreign" : "none";
			},
		});
		return found?.url;
	},
};
