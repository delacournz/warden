import type { ThemeSwitchProps } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { setTheme, useResolvedTheme } from "@/lib/theme.hook";

const ICONS = [
	["light", Sun],
	["dark", Moon],
] as const;

/**
 * Light / dark toggle for the Fumadocs layouts' `themeSwitch` slot, driven by
 * `@/lib/theme` instead of the next-themes provider Fumadocs ships. Neither
 * icon is marked active until hydration, when the theme becomes knowable.
 */
export function ThemeSwitch({ className }: ThemeSwitchProps) {
	const theme = useResolvedTheme();

	return (
		<button
			aria-label="Toggle Theme"
			className={cn("inline-flex items-center overflow-hidden rounded-full border p-1 *:rounded-full", className)}
			data-theme-toggle=""
			onClick={() => setTheme(theme === "light" ? "dark" : "light")}
			type="button"
		>
			{ICONS.map(([key, Icon]) => (
				<Icon
					className={cn(
						"size-6.5 p-1.5",
						theme === key ? "bg-fd-accent text-fd-accent-foreground" : "text-fd-muted-foreground"
					)}
					fill="currentColor"
					key={key}
				/>
			))}
		</button>
	);
}
