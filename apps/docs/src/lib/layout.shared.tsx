import type { BaseLayoutProps, GetLayoutTabsOptions } from "fumadocs-ui/layouts/shared";
import { ThemeSwitch } from "@/components/theme-switch";
import { WardenIcon } from "@/components/warden-icon";
import { appName, githubUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: (
				<span className="inline-flex items-center gap-2 whitespace-nowrap font-medium font-mono text-base tracking-[-0.02em]">
					<WardenIcon size={20} />
					{appName}
				</span>
			),
		},
		links: [
			{ type: "main", text: "Docs", url: "/docs", active: "nested-url" },
			{ type: "main", text: "CLI", url: "/docs/reference/cli", active: "nested-url" },
		],
		githubUrl,
		slots: { themeSwitch: ThemeSwitch },
	};
}

/**
 * The docs' top tabs: one per `root: true` folder under `content/docs` (Getting Started, Agents &
 * Simulators, E2E Tests, Reference, Releases). The navbar strip renders a tab's `title` only, so
 * the folder's lucide icon is folded into it too; below `lg` the same tabs become the sidebar's
 * switcher, which draws `icon` itself, so CSS shows the folded copy only in the strip.
 */
export const docsTabs: GetLayoutTabsOptions = {
	transform: (tab) => ({
		...tab,
		title: (
			<>
				<span aria-hidden="true" className="docs-tab-icon">
					{tab.icon}
				</span>
				{tab.title}
			</>
		),
	}),
};
