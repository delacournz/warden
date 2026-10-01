import { NPM_PACKAGE } from "../npm/platforms";

/**
 * How a package manager put this binary here, read off its path inside
 * `node_modules/@delacour/warden-<target>/`. `undefined` = a standalone binary (release / local build).
 */
export type PackageInstall =
	| { kind: "npm-global" | "bun-global" | "pnpm-global" | "npx" | "bunx" }
	| { kind: "project"; root: string };

const PLATFORM_DIR = `/node_modules/${NPM_PACKAGE}-`;

export function detectPackageInstall(execPath: string): PackageInstall | undefined {
	const path = execPath.replaceAll("\\", "/");
	if (!path.includes(PLATFORM_DIR)) return undefined;
	if (path.includes("/_npx/")) return { kind: "npx" };
	if (/\/bunx-[^/]*\//.test(path)) return { kind: "bunx" };
	if (path.includes("/install/global/node_modules/")) return { kind: "bun-global" };
	if (path.includes("/pnpm/global/")) return { kind: "pnpm-global" };
	if (path.includes("/lib/node_modules/")) return { kind: "npm-global" };
	return { kind: "project", root: path.slice(0, path.indexOf("/node_modules/")) };
}

/** What to run instead of `warden update` for a package-manager install. */
export function upgradeCommand(install: PackageInstall): string {
	switch (install.kind) {
		case "npm-global":
			return `npm i -g ${NPM_PACKAGE}@latest`;
		case "bun-global":
			return `bun add -g ${NPM_PACKAGE}@latest`;
		case "pnpm-global":
			return `pnpm add -g ${NPM_PACKAGE}@latest`;
		case "npx":
			return `npx ${NPM_PACKAGE}@latest install`;
		case "bunx":
			return `bunx ${NPM_PACKAGE}@latest install`;
		case "project":
			return `bump ${NPM_PACKAGE} in ${install.root}/package.json (e.g. \`npm i -D ${NPM_PACKAGE}@latest\`)`;
	}
}

export function describePackageInstall(install: PackageInstall): string {
	switch (install.kind) {
		case "npm-global":
			return `npm global install of ${NPM_PACKAGE}`;
		case "bun-global":
			return `bun global install of ${NPM_PACKAGE}`;
		case "pnpm-global":
			return `pnpm global install of ${NPM_PACKAGE}`;
		case "npx":
			return `npx run of ${NPM_PACKAGE} (cached, not installed)`;
		case "bunx":
			return `bunx run of ${NPM_PACKAGE} (cached, not installed)`;
		case "project":
			return `${NPM_PACKAGE} dependency of ${install.root}`;
	}
}

/** Global installs live at a stable path that upgrades replace in place; npx/bunx caches and projects don't. */
export function isStableInstall(install: PackageInstall): boolean {
	return install.kind === "npm-global" || install.kind === "bun-global" || install.kind === "pnpm-global";
}
