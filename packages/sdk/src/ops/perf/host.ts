import { metroTools } from "@delacour/warden-builds/metro";
import { metroFinder } from "@delacour/warden-devtools/metro";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import { leaseModel } from "@delacour/warden-store/types";
import { perfDeviceState } from "./device-state";
import type { PerfHostDeps } from "./types";

/** Real host facts: the Metro lookup the device's remembered URL, `WARDEN_METRO_URL` and the owner's leased ports feed. */
export const defaultPerfHostDeps: PerfHostDeps = {
	platform: process.platform,
	metro: async (env, udid) => {
		const owner = ownerResolver.resolve(env);
		const stateUrl = udid === undefined ? undefined : perfDeviceState.readMetroUrl(env, udid);
		const portLeases = env
			.store()
			.listLeases()
			.flatMap((l) => (l.resource.kind === "port" && leaseModel.sameOwner(l.owner, owner) ? [l.resource.port] : []));
		const found = await metroFinder.find({
			...(env.env.WARDEN_METRO_URL === undefined ? {} : { env: env.env.WARDEN_METRO_URL }),
			...(stateUrl === undefined ? {} : { stateMetroUrl: stateUrl }),
			portLeases,
			probe: async (port) => {
				const probed = await metroTools.owner(env.exec, port, env.cwd);
				return probed.kind === "ours" ? "ours" : probed.kind === "foreign" ? "foreign" : "none";
			},
		});
		return found?.url;
	},
};
