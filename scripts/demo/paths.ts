import { join } from "node:path";

/** Every file a demo reads or writes, from its `<feature>/<clip>` name. */
export type DemoPaths = {
	/** `apps/example/demos/<feature>/<clip>.demo.ts` */
	definition: string;
	/** `apps/docs/public/demos/<feature>`, served at `/demos/<feature>/`. */
	publicDir: string;
	mp4: string;
	jpg: string;
	/** Take, steps, plan and sheet: `<tmp>/warden-demo/<feature>/<clip>`. */
	work: string;
	/** `warden claim --label`: no slash. */
	label: string;
};

const NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Resolves a demo name such as `biometrics/faceid`; throws on anything but one lower-case feature folder and clip. */
export function demoPaths(repo: string, name: string, tmp: string): DemoPaths {
	const m = NAME.exec(name);
	if (!m) throw new Error(`demo name must be <feature>/<clip> (lower-case, hyphens), got "${name}"`);
	const [, feature = "", clip = ""] = m;
	const publicDir = join(repo, "apps/docs/public/demos", feature);
	return {
		definition: join(repo, "apps/example/demos", feature, `${clip}.demo.ts`),
		publicDir,
		mp4: join(publicDir, `${clip}.mp4`),
		jpg: join(publicDir, `${clip}.jpg`),
		work: join(tmp, "warden-demo", feature, clip),
		label: `demo-${feature}-${clip}`,
	};
}
