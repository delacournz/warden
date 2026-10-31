import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
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
